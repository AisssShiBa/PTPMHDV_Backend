import '../setup'
import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { Server } from 'node:http'
import request from 'supertest'
import { createTestGatewayToken } from 'finvault-internal-auth'
import { parseFinvaultEvent } from 'finvault-events'
import userApp from '../../src/app'
import { prisma } from '../../src/config/prisma'
import { env } from '../../src/config/env'
import { storage } from '../../src/services/storage'

let server: Server, adminApp: any, auditDb: any
const adminId = randomUUID()
const adminHeaders = { 'x-gateway-token': createTestGatewayToken(adminId, 'ADMIN') }

type Status = 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED'
function create(options: { kycStatus?: Status; kycTier?: number; kycRejectReason?: string } = {}) {
  return prisma.user.create({ data: {
    authUserId: randomUUID(), email: randomUUID() + '@example.com',
    kycStatus: options.kycStatus ?? 'PENDING', kycTier: options.kycTier ?? 0,
    kycRejectReason: options.kycRejectReason, idNumber: '000000001234',
    kycObjectKey: 'kyc/front.jpg', kycBackObjectKey: 'kyc/back.jpg'
  } })
}
const owner = (user: { authUserId: string }) => ({ 'x-gateway-token': createTestGatewayToken(user.authUserId, 'USER') })

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
})
beforeEach(async () => {
  await prisma.userOutboxEvent.deleteMany()
  await prisma.user.deleteMany()
  await auditDb.adminAuditLog.deleteMany()
})
after(async () => {
  server?.closeAllConnections()
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  await Promise.all([prisma.$disconnect(), auditDb?.$disconnect()])
})

// K01: mandatory, non-blank reason; a rejected request must not mutate or emit anything.
test('K01 reject without a reason is rejected before any status change or outbox row', async () => {
  // Tier 1 makes the "no event" assertion meaningful: a successful reject would emit one.
  const user = await create({ kycTier: 1 })
  const path = `/api/users/${user.id}/kyc-status`
  for (const body of [
    { kycStatus: 'REJECTED' },
    { kycStatus: 'REJECTED', reason: '' },
    { kycStatus: 'REJECTED', reason: '   ' },
    { kycStatus: 'REJECTED', reason: 'x'.repeat(501) },
    { kycStatus: 'REJECTED', reason: 42 },
    { kycStatus: 'REJECTED', reason: 'ok', extra: true }
  ]) {
    const response = await request(userApp).patch(path).set(adminHeaders).send(body).expect(400)
    assert.equal(response.body.error.code, 'VALIDATION_ERROR')
  }
  const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
  assert.equal(unchanged.kycStatus, 'PENDING')
  assert.equal(unchanged.kycTier, 1)
  assert.equal(unchanged.kycRejectReason, null)
  assert.equal(unchanged.version, 0)
  assert.equal(await prisma.userOutboxEvent.count(), 0)
})

// K02: real Admin -> User path; the reason reaches the owner and the audit trail.
test('K02 reject with reason persists it, shows it only to the owner, and audits it', async () => {
  const user = await create()
  const detail = 'Back image is blurry and the expiry is unreadable'
  const reviewed = await request(adminApp).post(`/api/admin/kyc/${user.id}/review`).set(adminHeaders)
    .send({ status: 'REJECTED', detail }).expect(200)
  assert.equal(reviewed.body.data.kycStatus, 'REJECTED')
  assert.equal(reviewed.body.data.kycRejectReason, undefined)

  const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
  assert.equal(row.kycStatus, 'REJECTED')
  assert.equal(row.kycRejectReason, detail)

  const mine = await request(userApp).get('/api/users/me/kyc').set(owner(user)).expect(200)
  assert.equal(mine.body.data.kycStatus, 'REJECTED')
  assert.equal(mine.body.data.kycRejectReason, detail)

  // Owner profile routes strip the reason; another user cannot read the profile at all.
  const profile = await request(userApp).get(`/api/users/${user.id}`).set(owner(user)).expect(200)
  assert.equal(profile.body.data.kycRejectReason, undefined)
  await request(userApp).get(`/api/users/${user.id}`).set(owner({ authUserId: randomUUID() })).expect(403)
  await request(userApp).get('/api/users/me/kyc').set(owner({ authUserId: randomUUID() })).expect(404)

  const audits = await auditDb.adminAuditLog.findMany()
  assert.equal(audits.length, 1)
  assert.equal(audits[0].action, 'REJECT_KYC')
  assert.equal(audits[0].targetId, user.id)
  const auditDetail = JSON.parse(audits[0].detail)
  assert.equal(auditDetail.outcome, 'SUCCEEDED')
  assert.equal(auditDetail.reason, detail)
  assert.equal(auditDetail.kycStatus, 'REJECTED')
})

// K03 is NOT certifiable yet: the plan wants PENDING->REJECTED to keep the existing tier,
// the code still forces tier 0. This test pins today's behaviour so a policy change is visible.
test('K03 documents the current, not yet agreed, tier rule for reject', async () => {
  const pending = await create({ kycTier: 1 })
  const rejected = await request(userApp).patch(`/api/users/${pending.id}/kyc-status`).set(adminHeaders)
    .send({ kycStatus: 'REJECTED', reason: 'Pending profile rejected' }).expect(200)
  assert.equal(rejected.body.data.kycTier, 0) // Plan asks to keep 1 here; BLOCKED on team decision.

  const approved = await create({ kycStatus: 'APPROVED', kycTier: 1 })
  await request(userApp).patch(`/api/users/${approved.id}/kyc-status`).set(adminHeaders)
    .send({ kycStatus: 'REJECTED', reason: 'Approved profile rejected' }).expect(200)
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: approved.id } })).kycTier, 0)
  // APPROVED tier 1 -> 0 still notifies Wallet; the PENDING case above stays tier 0 either way.
  const events = await prisma.userOutboxEvent.findMany({ where: { aggregateId: approved.id } })
  assert.equal(events.length, 1)
  assert.deepEqual((events[0].payload as any).data,
    { authUserId: approved.authUserId, kycTier: 0, previousTier: 1 })
})

// K04 (partial): the tier event must survive. The review event is BLOCKED (see below).
test('K04 approval keeps exactly one user.kyc_updated and emits no review event', async () => {
  const user = await create()
  await request(adminApp).post(`/api/admin/kyc/${user.id}/review`).set(adminHeaders)
    .send({ status: 'APPROVED' }).expect(200)
  const events = await prisma.userOutboxEvent.findMany()
  assert.equal(events.length, 1)
  assert.equal(events[0].eventType, 'user.kyc_updated')
  assert.deepEqual((events[0].payload as any).data,
    { authUserId: user.authUserId, kycTier: 1, previousTier: 0 })
  assert.equal(await prisma.userOutboxEvent.count({ where: { eventType: 'user.kyc_reviewed' } }), 0)
})

// Evidence for the BLOCKED review event: both mechanisms are observable here.
test('user.kyc_reviewed is BLOCKED by outbox version uniqueness and the unregistered schema', async () => {
  // APPROVED -> REJECTED moves the tier 1 -> 0, so this transition DOES write a tier event.
  const user = await create({ kycStatus: 'APPROVED', kycTier: 1 })
  await request(adminApp).post(`/api/admin/kyc/${user.id}/review`).set(adminHeaders)
    .send({ status: 'REJECTED', detail: 'Rejected for test' }).expect(200)
  const [tierEvent] = await prisma.userOutboxEvent.findMany()
  assert.equal(tierEvent.aggregateVersion, 1)

  // (a) A review event for the same transition would reuse (aggregateId, aggregateVersion).
  await assert.rejects(prisma.userOutboxEvent.create({ data: {
    id: randomUUID(), aggregateId: user.id, aggregateVersion: tierEvent.aggregateVersion,
    eventType: 'user.kyc_reviewed',
    payload: { eventId: randomUUID(), eventType: 'user.kyc_reviewed', eventVersion: 1,
      occurredAt: new Date().toISOString(), data: { authUserId: user.authUserId, status: 'REJECTED' } }
  } }), (error: any) => error.code === 'P2002')

  // (b) Even if the row existed, the shared publisher contract would refuse to publish it.
  assert.throws(() => parseFinvaultEvent({ eventId: randomUUID(), eventType: 'user.kyc_reviewed',
    eventVersion: 1, occurredAt: new Date().toISOString(),
    data: { authUserId: user.authUserId, status: 'REJECTED' } }), (error: any) => error.reason === 'UNKNOWN_EVENT_TYPE')
})

// K05: two concurrent reviews of one profile commit exactly one transition and one event.
test('K05 concurrent reviews produce one transition and one tier event', async () => {
  const user = await create({ kycStatus: 'APPROVED', kycTier: 1 })
  const path = `/api/admin/kyc/${user.id}/review`
  const results = await Promise.all([1, 2].map(() => request(adminApp).post(path).set(adminHeaders)
    .send({ status: 'REJECTED', detail: 'Concurrent review' })))
  // The loser either loses the version CAS (409) or reads the committed state and no-ops (200).
  assert.ok(results.every(result => [200, 409].includes(result.status)))
  assert.ok(results.some(result => result.status === 200))
  const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
  assert.equal(row.kycStatus, 'REJECTED')
  assert.equal(row.version, 1)
  const events = await prisma.userOutboxEvent.findMany()
  assert.equal(events.length, 1)
  assert.deepEqual((events[0].payload as any).data,
    { authUserId: user.authUserId, kycTier: 0, previousTier: 1 })
})

// K07: the default wired into signing is 900s; the 2s expiry proof lives in storage.test.ts:175.
test('K07 default signed URL lifetime is 900 seconds and no-store', async () => {
  assert.equal(env.kycUrlTtlSeconds, 900)
  const url = await storage.url('kyc/front.jpg')
  assert.equal(new URL(url).searchParams.get('X-Amz-Expires'), '900')
  assert.equal(new URL(url).searchParams.get('response-cache-control'), 'no-store')
})

// K08: misrouted document reads are 403 and no CCCD or presigned URL reaches the logs.
test('K08 wrong-endpoint document reads are 403 and logs carry no CCCD or signed URL', async () => {
  const user = await create({ kycStatus: 'REJECTED', kycRejectReason: 'Blurry document' })
  const captured: string[] = []
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info }
  const record = (...args: unknown[]) => { captured.push(args.map(String).join(' ')) }
  console.log = record; console.error = record; console.warn = record; console.info = record
  try {
    await request(userApp).get(`/api/users/${user.id}/kyc/document`).set(adminHeaders).expect(403)
    await request(userApp).get(`/api/users/${user.id}/kyc/documents`).set(adminHeaders).expect(403)
    await request(userApp).get(`/api/users/${user.id}/kyc/documents`).set(owner(user)).expect(403)
    await request(userApp).patch(`/api/users/${user.id}/kyc-status`).set(adminHeaders)
      .send({ kycStatus: 'REJECTED', reason: 'Back image is blurry' }).expect(200)
  } finally {
    console.log = original.log; console.error = original.error
    console.warn = original.warn; console.info = original.info
  }
  const output = captured.join('\n')
  assert.equal(output.includes('000000001234'), false)
  assert.equal(output.includes('X-Amz-Signature'), false)
  assert.equal(output.includes('X-Amz-Credential'), false)
  assert.equal(output.includes('Back image is blurry'), false)
  assert.equal(output.includes('Blurry document'), false)
})
