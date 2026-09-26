import '../setup'
import { stub } from '../stub'
import { test, before, beforeEach, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import amqp from 'amqplib'
import app from '../../src/app'
import { prisma } from '../../src/config/prisma'
import { env } from '../../src/config/env'
import { register, changeStatus } from '../../src/services/merchant.service'
import { publishOne, claimEvent, replayFailed } from '../../src/events/outbox'
import { publishConfirmed } from '../../src/events/amqp'
const internal = { 'x-internal-key': process.env.INTERNAL_KEY! }
const auth = (userId: string, role = 'USER') => ({ 'x-gateway-verified': 'true', authorization: 'Bearer ' + jwt.sign({ userId, role }, process.env.ACCESS_TOKEN_SECRET!) })
before(async () => { assert.ok(process.env.DATABASE_URL?.includes('/finvault_test?schema=merchant_test')); await prisma.$connect() })
beforeEach(async () => { await prisma.merchantOutboxEvent.deleteMany(); await prisma.merchant.deleteMany() })
after(() => prisma.$disconnect())
test('concurrent registration creates one merchant and one transactional event', async () => {
  const ownerId = randomUUID()
  const results = await Promise.all(Array.from({ length: 5 }, () => request(app).post('/api/merchants/register').set(internal).send({ ownerId, businessName: 'Shop' })))
  assert.equal(results.filter(r => r.status === 201).length, 1)
  assert.ok(results.every(r => [201, 409].includes(r.status)))
  assert.equal(await prisma.merchant.count(), 1)
  const events = await prisma.merchantOutboxEvent.findMany()
  assert.equal(events.length, 1)
  assert.equal(events[0].eventType, 'merchant.registered')
  assert.equal((events[0].payload as any).data.version, 1)
})
test('outbox insert failure rolls back merchant creation', async () => {
  const original = prisma.$transaction.bind(prisma)
  stub(prisma, '$transaction', (callback: any, options: any) => original(async tx => {
    tx.merchantOutboxEvent.create = (async () => { throw new Error('Simulated outbox failure') }) as any
    return callback(tx)
  }, options))
  await assert.rejects(register({ ownerId: randomUUID(), businessName: 'Rollback' }))
  assert.equal(await prisma.merchant.count(), 0)
  assert.equal(await prisma.merchantOutboxEvent.count(), 0)
})
test('status transitions create ordered events; repeated status is a no-op', async () => {
  const merchant = await register({ ownerId: randomUUID(), businessName: 'Shop' })
  const approved = await changeStatus(merchant.id, 'APPROVED')
  assert.equal(approved.version, 2)
  await changeStatus(merchant.id, 'APPROVED')
  assert.equal(await prisma.merchantOutboxEvent.count(), 2)
  await assert.rejects(changeStatus(merchant.id, 'PENDING'), (e: any) => e.code === 'INVALID_TRANSITION')
  await changeStatus(merchant.id, 'REJECTED')
  await changeStatus(merchant.id, 'PENDING')
  assert.deepEqual((await prisma.merchantOutboxEvent.findMany({ orderBy: { aggregateVersion: 'asc' } })).map(e => e.aggregateVersion), [1, 2, 3, 4])
})
test('active endpoint covers all states, hides bank account and excludes deleted records', async () => {
  const merchant = await register({ ownerId: randomUUID(), businessName: 'Shop', bankAccount: 'secret-account' })
  for (const status of ['PENDING', 'APPROVED', 'REJECTED'] as const) {
    await prisma.merchant.update({ where: { id: merchant.id }, data: { status } })
    const response = await request(app).get('/api/merchants/' + merchant.id + '/active').set(internal).expect(200)
    assert.equal(response.body.data.active, status === 'APPROVED')
    assert.equal(response.body.data.bankAccount, undefined)
  }
  await request(app).get('/api/merchants/' + randomUUID() + '/active').set(internal).expect(404)
  await request(app).get('/api/merchants/' + merchant.id + '/active').expect(403)
  await prisma.merchant.update({ where: { id: merchant.id }, data: { deletedAt: new Date() } })
  await request(app).get('/api/merchants/' + merchant.id + '/active').set(internal).expect(404)
  const list = await request(app).get('/api/merchants').set(internal).expect(200)
  assert.equal(list.body.data.totalElements, 0)
})
test('owner can update profile; only administrator/internal can review', async () => {
  const merchant = await register({ ownerId: randomUUID(), businessName: 'Shop' })
  await request(app).put('/api/merchants/' + merchant.id).set(auth(merchant.ownerId)).send({ businessName: ' New name ' }).expect(200)
  await request(app).patch('/api/merchants/' + merchant.id + '/status').set(auth(merchant.ownerId)).send({ status: 'APPROVED' }).expect(403)
  await request(app).patch('/api/merchants/' + merchant.id + '/status').set(auth(randomUUID(), 'ADMIN')).send({ status: 'APPROVED' }).expect(200)
})
test('expired worker leases recover; parallel claims cannot overtake prior aggregate events', async () => {
  const merchant = await register({ ownerId: randomUUID(), businessName: 'Shop' })
  await changeStatus(merchant.id, 'APPROVED')
  const claims = await Promise.all([claimEvent(), claimEvent()])
  assert.equal(claims.filter(Boolean).length, 1)
  const first = claims.find(Boolean)!
  assert.equal(first.aggregateVersion, 1)
  await prisma.merchantOutboxEvent.update({ where: { id: first.id }, data: { lockedUntil: new Date(0) } })
  await prisma.$disconnect()
  const recovered = await claimEvent()
  assert.equal(recovered?.id, first.id)
  assert.notEqual(recovered?.lockToken, first.lockToken)
})
test('publish failure backs off, stops at FAILED, and replay unblocks later events', async () => {
  const merchant = await register({ ownerId: randomUUID(), businessName: 'Shop' })
  await changeStatus(merchant.id, 'APPROVED')
  await publishOne(async () => { throw new Error('Broker down') })
  let event = await prisma.merchantOutboxEvent.findFirstOrThrow({ where: { aggregateVersion: 1 } })
  assert.equal(event.status, 'PENDING')
  assert.equal(event.attempts, 1)
  assert.ok(event.nextAttemptAt.getTime() > event.createdAt.getTime())
  await prisma.merchantOutboxEvent.update({ where: { id: event.id }, data: { nextAttemptAt: new Date(0) } })
  await publishOne(async () => { throw new Error('Still down') })
  event = await prisma.merchantOutboxEvent.findUniqueOrThrow({ where: { id: event.id } })
  assert.equal(event.status, 'FAILED')
  assert.equal(await claimEvent(), null)
  await replayFailed(event.id)
  await publishOne(async () => {})
  const next = await claimEvent()
  assert.equal(next?.aggregateVersion, 2)
})
test('real RabbitMQ confirm persists publication and unroutable events stay retryable', async () => {
  const connection = await amqp.connect(env.rabbitmqUrl!)
  try {
    const channel = await connection.createConfirmChannel()
    channel.on('error', () => {})
    await channel.assertExchange(env.eventExchange, 'topic', { durable: true })
    const queue = await channel.assertQueue('', { exclusive: true })
    await channel.bindQueue(queue.queue, env.eventExchange, 'merchant.registered')
    const merchant = await register({ ownerId: randomUUID(), businessName: 'Real broker' })
    const send = (e: any) => publishConfirmed(channel, env.eventExchange, e.eventType, Buffer.from(JSON.stringify(e.payload)), { messageId: e.id })
    await publishOne(send)
    const message = await channel.get(queue.queue, { noAck: true })
    assert.ok(message)
    assert.equal(JSON.parse(message.content.toString()).data.merchantId, merchant.id)
    assert.equal((await prisma.merchantOutboxEvent.findFirstOrThrow()).status, 'PUBLISHED')
    await changeStatus(merchant.id, 'APPROVED') // status_updated has no binding.
    await publishOne(send)
    const failed = await prisma.merchantOutboxEvent.findFirstOrThrow({ where: { aggregateVersion: 2 } })
    assert.equal(failed.status, 'PENDING')
    assert.equal(failed.lastError, 'PUBLISH_FAILED')
  } finally { await connection.close() }
})
test('publisher process restart resumes durable pending events', async () => {
  const connection = await amqp.connect(env.rabbitmqUrl!)
  let worker: ChildProcess | undefined
  const stop = async () => {
    if (worker && worker.exitCode === null) { const exited = once(worker, 'exit'); worker.kill(); await exited }
  }
  const start = () => {
    worker = spawn(process.execPath, ['--import', 'tsx', 'src/events/worker.ts'], { cwd: process.cwd(), env: process.env, stdio: 'ignore', windowsHide: true })
  }
  const waitPublished = async (count: number) => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (await prisma.merchantOutboxEvent.count({ where: { status: 'PUBLISHED' } }) === count) return
      await sleep(100)
    }
    throw new Error('Publisher did not drain outbox')
  }
  try {
    const channel = await connection.createChannel()
    await channel.assertExchange(env.eventExchange, 'topic', { durable: true })
    const queue = await channel.assertQueue('', { exclusive: true })
    await channel.bindQueue(queue.queue, env.eventExchange, 'merchant.*')
    const merchant = await register({ ownerId: randomUUID(), businessName: 'Restart' })
    start()
    await waitPublished(1)
    await stop()
    await changeStatus(merchant.id, 'APPROVED')
    start()
    await waitPublished(2)
    const messages = []
    for (let i = 0; i < 2; i++) {
      const message = await channel.get(queue.queue, { noAck: true })
      assert.ok(message)
      messages.push(JSON.parse(message.content.toString()))
    }
    assert.deepEqual(messages.map(m => m.data.version), [1, 2])
  } finally { await stop(); await connection.close() }
})
test('outbox scheduling tolerates application clock skew', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() + 600000 })
  try {
    await register({ ownerId: randomUUID(), businessName: 'Clock skew' })
    assert.equal(await publishOne(async () => { throw new Error('Temporary broker failure') }), true)
    const times = await prisma.$queryRaw<{ delay: number }[]>`
      SELECT EXTRACT(EPOCH FROM (next_attempt_at - NOW()))::float8 AS delay
      FROM merchant_outbox_events
    `
    assert.ok(times[0].delay < 1, 'Retry must use database time, not the application clock ten minutes ahead')
    const event = await prisma.merchantOutboxEvent.findFirstOrThrow()
    await prisma.merchantOutboxEvent.update({ where: { id: event.id }, data: { status: 'FAILED' } })
    await replayFailed(event.id)
    assert.ok(await claimEvent(), 'Replay is immediately eligible despite clock skew')
  } finally { mock.timers.reset() }
})
