import '../setup'
import { stub } from '../stub'
import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { Server } from 'node:http'
import request from 'supertest'
import amqp, { ChannelModel, ConfirmChannel } from 'amqplib'
import { createTestGatewayToken } from 'finvault-internal-auth'
import userApp from '../../src/app'
import { prisma } from '../../src/config/prisma'
import { env } from '../../src/config/env'
import { setKycStatus } from '../../src/services/user.service'
import { updateKycTier } from '../../src/services/kyc-tier.service'
import { claimEvent, publishOne, replayFailed } from '../../src/events/outbox'
import { startOutboxPublisher } from '../../src/events/publisher'

let server: Server, adminApp: any, auditDb: any
let connection: ChannelModel, channel: ConfirmChannel, queue: string
const adminId = randomUUID()
const adminHeaders = { 'x-gateway-token': createTestGatewayToken(adminId, 'ADMIN') }
const create = () => prisma.user.create({ data: {
  authUserId: randomUUID(), email: randomUUID() + '@example.com', kycStatus: 'PENDING',
  idNumber: '000000001234', kycObjectKey: 'kyc/front.jpg', kycBackObjectKey: 'kyc/back.jpg'
} })
before(async () => {
  assert.ok(env.databaseUrl.includes('/finvault_test?schema=user_test'))
  await prisma.$connect()
  server = userApp.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const originalUrl = process.env.DATABASE_URL
  process.env.USER_SERVICE_URL = `http://127.0.0.1:${(server.address() as any).port}`
  process.env.DATABASE_URL = originalUrl!.replace('schema=user_test', 'schema=admin_test')
  try {
    adminApp = require('../../../admin-service/src/app').default
    auditDb = require('../../../admin-service/src/config/prisma').prisma
  } finally { process.env.DATABASE_URL = originalUrl }
  connection = await amqp.connect(env.rabbitmqUrl!)
  channel = await connection.createConfirmChannel()
  await channel.assertExchange(env.eventExchange, 'topic', { durable: true })
  queue = (await channel.assertQueue('', { exclusive: true })).queue
  await channel.bindQueue(queue, env.eventExchange, 'user.kyc_updated')
})
beforeEach(async () => {
  await prisma.userOutboxEvent.deleteMany()
  await prisma.user.deleteMany()
  await auditDb.adminAuditLog.deleteMany()
  await channel.purgeQueue(queue)
})
after(async () => {
  await connection?.close()
  server?.closeAllConnections()
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  await Promise.all([prisma.$disconnect(), auditDb?.$disconnect()])
})
async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) { if (await check()) return; await delay(50) }
  throw new Error('Timed out waiting for publisher')
}

test('S11: real Admin -> User approval/rejection writes audit and publishes ordered tier changes to RabbitMQ', async () => {
  const user = await create()
  const path = `/api/admin/kyc/${user.id}`
  const approved = await request(adminApp).post(path + '/review').set(adminHeaders).send({ status: 'APPROVED' }).expect(200)
  assert.equal(approved.body.data.kycTier, 1)
  await request(adminApp).patch(path + '/tier').set(adminHeaders).send({ tier: 2, reason: 'Simulated bank link' }).expect(200)
  const rejected = await request(adminApp).post(path + '/review').set(adminHeaders).send({ status: 'REJECTED' }).expect(200)
  assert.equal(rejected.body.data.kycTier, 0)
  const audits = await auditDb.adminAuditLog.findMany({ orderBy: { createdAt: 'asc' } })
  assert.deepEqual(audits.map((row: any) => row.action), ['APPROVE_KYC', 'UPDATE_KYC_TIER', 'REJECT_KYC'])
  assert.ok(audits.every((row: any) => row.adminId === adminId && JSON.parse(row.detail).outcome === 'SUCCEEDED'))
  assert.equal(JSON.stringify(audits).includes(user.idNumber!), false)
  const controller = new AbortController()
  const workers = [startOutboxPublisher(controller.signal), startOutboxPublisher(controller.signal)]
  try { await waitFor(async () => await prisma.userOutboxEvent.count({ where: { status: 'PUBLISHED' } }) === 3) }
  finally { controller.abort(); await Promise.all(workers) }
  const events = []
  for (let i = 0; i < 3; i++) {
    const message = await channel.get(queue, { noAck: true })
    assert.ok(message)
    const event = JSON.parse(message.content.toString())
    assert.equal(message.fields.routingKey, 'user.kyc_updated')
    assert.equal(message.properties.messageId, event.eventId)
    events.push(event)
  }
  assert.deepEqual(events.map(e => e.data), [
    { authUserId: user.authUserId, kycTier: 1, previousTier: 0 },
    { authUserId: user.authUserId, kycTier: 2, previousTier: 1 },
    { authUserId: user.authUserId, kycTier: 0, previousTier: 2 }
  ])
  assert.equal(new Set(events.map(e => e.eventId)).size, 3)
  assert.equal(await publishOne(async () => assert.fail('published rows must not be resent')), false)
  assert.equal(await channel.get(queue, { noAck: true }), false)
})

test('review rolls back status, tier and version when outbox insertion fails', async () => {
  const user = await create()
  const original = prisma.$transaction.bind(prisma)
  stub(prisma, '$transaction', (work: any, options: any) => original(async tx => {
    tx.userOutboxEvent.create = (async () => { throw new Error('Injected failure') }) as any
    return work(tx)
  }, options))
  await assert.rejects(setKycStatus(user, 'APPROVED'))
  const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
  assert.equal(row.kycStatus, 'PENDING'); assert.equal(row.kycTier, 0); assert.equal(row.version, 0)
  assert.equal(await prisma.userOutboxEvent.count(), 0)
})

test('unconfirmed messages retry, failed rows require replay, and expired leases retain event identity', async () => {
  const user = await create()
  await updateKycTier(user.id, 1)
  const first = await prisma.userOutboxEvent.findFirstOrThrow()
  for (let attempt = 0; attempt < env.eventMaxRetries; attempt++) {
    await prisma.userOutboxEvent.update({ where: { id: first.id }, data: { nextAttemptAt: new Date(0) } })
    await publishOne(async row => {
      assert.equal(row.id, first.id)
      assert.equal((await prisma.userOutboxEvent.findUniqueOrThrow({ where: { id: row.id } })).publishedAt, null)
      throw new Error('Broker did not confirm')
    })
  }
  assert.equal((await prisma.userOutboxEvent.findUniqueOrThrow({ where: { id: first.id } })).status, 'FAILED')
  assert.equal(await claimEvent(), null)
  assert.equal((await replayFailed(first.id)).count, 1)
  const claimed = await claimEvent()
  assert.equal(claimed?.id, first.id)
  assert.equal(await claimEvent(), null)
  await prisma.userOutboxEvent.update({ where: { id: first.id }, data: { lockedUntil: new Date(0) } })
  const recovered = await claimEvent()
  assert.equal(recovered?.id, first.id)
  assert.notEqual(recovered?.lockToken, claimed?.lockToken)
  assert.deepEqual(recovered?.payload, first.payload)
})

test('Admin validation/authorization and audit failures prevent remote tier changes', async () => {
  const user = await create()
  const path = `/api/admin/kyc/${user.id}/tier`
  await request(adminApp).patch(path).set('x-gateway-token', createTestGatewayToken(user.authUserId)).send({ tier: 2, reason: 'test' }).expect(403)
  for (const body of [{ tier: 0, reason: 'test' }, { tier: 2 }, { tier: '2', reason: 'test' }])
    await request(adminApp).patch(path).set(adminHeaders).send(body).expect(400)
  await request(adminApp).patch(path).set(adminHeaders).send({ tier: 2, reason: 'test' }).expect(409)
  stub(auditDb.adminAuditLog, 'create', async () => { throw new Error('Audit DB down') })
  await request(adminApp).post(`/api/admin/kyc/${user.id}/review`).set(adminHeaders).send({ status: 'APPROVED' }).expect(503)
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).kycTier, 0)
  assert.equal(await prisma.userOutboxEvent.count(), 0)
})

test('documents endpoint returns two expiring URLs with audit, rejects USER, and reports incomplete legacy uploads', async () => {
  const user = await create()
  await prisma.user.update({ where: { id: user.id }, data: { kycBackObjectKey: null } })
  const path = `/api/admin/kyc/${user.id}/documents`
  await request(adminApp).get(path).set('x-gateway-token', createTestGatewayToken(user.authUserId)).expect(403)
  await request(adminApp).get(path).set(adminHeaders).expect(404)
  await prisma.user.update({ where: { id: user.id }, data: { kycBackObjectKey: 'kyc/back.jpg' } })
  const result = await request(adminApp).get(path).set(adminHeaders).expect(200)
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.ok(result.body.data.frontUrl.includes('kyc/front.jpg'))
  assert.ok(result.body.data.backUrl.includes('kyc/back.jpg'))
  assert.equal(new URL(result.body.data.frontUrl).searchParams.get('X-Amz-Expires'), '300')
  const audits = await auditDb.adminAuditLog.findMany({ where: { action: 'VIEW_KYC_DOCUMENTS' } })
  assert.equal(audits.length, 2)
  assert.equal(JSON.stringify(audits).includes('X-Amz-Signature'), false)
})
