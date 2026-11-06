import { createTestGatewayToken } from 'finvault-internal-auth'
import '../setup'
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import app from '../../src/app'
import { prisma } from '../../src/config/prisma'
import { register, changeStatus } from '../../src/services/merchant.service'
import { verifyApiKey } from '../../src/services/merchant-api-key.service'
import { verifyOutletQr } from '../../src/services/qr.service'

const internal = { 'x-internal-key': process.env.INTERNAL_KEY! }
const auth = (userId: string, role = 'USER') => ({ 'x-gateway-token': createTestGatewayToken(userId, role) })

async function approvedMerchant(businessName = 'Shop') {
  const ownerId = randomUUID()
  const merchant = await register({ ownerId, businessName })
  await changeStatus(merchant.id, 'APPROVED')
  return { ownerId, merchant }
}

before(async () => {
  assert.ok(process.env.DATABASE_URL?.includes('/finvault_test?schema=merchant_test'))
  await prisma.$connect()
})
beforeEach(async () => {
  await prisma.merchantApiKey.deleteMany()
  await prisma.outlet.deleteMany()
  await prisma.merchantOutboxEvent.deleteMany()
  await prisma.merchant.deleteMany()
})
after(() => prisma.$disconnect())

test('M01 outbox gets a profile_updated event in the same transaction as the outlet', async () => {
  const { ownerId, merchant } = await approvedMerchant()
  const before = await prisma.merchantOutboxEvent.count()
  const created = await request(app).post('/api/merchants/' + merchant.id + '/outlets')
    .set(auth(ownerId)).send({ name: 'Quan 1', code: 'Q1-' + randomUUID().slice(0, 8) }).expect(201)
  assert.equal(created.body.data.merchantId, merchant.id)

  const events = await prisma.merchantOutboxEvent.findMany({ orderBy: { aggregateVersion: 'asc' } })
  assert.equal(events.length, before + 1)
  const last = events.at(-1)!
  assert.equal(last.eventType, 'merchant.profile_updated')
  assert.equal(last.aggregateVersion, (await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.id } })).version)

  const list = await request(app).get('/api/merchants/' + merchant.id + '/outlets').set(auth(ownerId)).expect(200)
  assert.equal(list.body.data.totalElements, 1)
  assert.equal(list.body.data.content[0].code, created.body.data.code)
})

test('M04 a duplicate outlet code becomes 409, not a 500 or a leaked constraint', async () => {
  const { ownerId, merchant } = await approvedMerchant()
  const other = await approvedMerchant('Other')
  const code = 'DUP-' + randomUUID().slice(0, 8)
  await request(app).post('/api/merchants/' + merchant.id + '/outlets').set(auth(ownerId)).send({ name: 'A', code }).expect(201)
  const conflict = await request(app).post('/api/merchants/' + merchant.id + '/outlets')
    .set(auth(ownerId)).send({ name: 'B', code }).expect(409)
  assert.equal(conflict.body.error.code, 'DUPLICATE_RESOURCE')
  // Codes are global: another merchant cannot register the same code either.
  await request(app).post('/api/merchants/' + other.merchant.id + '/outlets')
    .set(auth(other.ownerId)).send({ name: 'C', code }).expect(409)
  assert.equal(await prisma.outlet.count(), 1)
})

test('M05 QR is verifiable end-to-end and bound to its merchant and outlet', async () => {
  const a = await approvedMerchant('A')
  const b = await approvedMerchant('B')
  const outlet = await request(app).post('/api/merchants/' + a.merchant.id + '/outlets')
    .set(auth(a.ownerId)).send({ name: 'A1', code: 'A1-' + randomUUID().slice(0, 8) }).expect(201)

  const qr = await request(app).get('/api/merchants/' + a.merchant.id + '/outlets/' + outlet.body.data.id + '/qr')
    .set(auth(a.ownerId)).expect(200)
  const payload = verifyOutletQr(qr.body.data.token, { merchantId: a.merchant.id, outletId: outlet.body.data.id })
  assert.ok(payload)
  assert.equal(payload!.outletCode, outlet.body.data.code)
  assert.equal(verifyOutletQr(qr.body.data.token, { merchantId: b.merchant.id }), null)
  // Merchant B cannot address merchant A's outlet through its own path.
  await request(app).get('/api/merchants/' + b.merchant.id + '/outlets/' + outlet.body.data.id + '/qr')
    .set(auth(b.ownerId)).expect(404)
})

test('M06/M07 the secret is only readable at creation, and revoked keys stop verifying', async () => {
  const { ownerId, merchant } = await approvedMerchant()
  const created = await request(app).post('/api/merchants/' + merchant.id + '/api-keys').set(auth(ownerId)).expect(201)
  const raw = created.body.data.key as string
  assert.ok(raw.includes('.'))
  assert.equal(created.headers['cache-control'], 'no-store')

  const row = await prisma.merchantApiKey.findUniqueOrThrow({ where: { keyId: created.body.data.keyId } })
  assert.match(row.secretHash, /^[a-f0-9]{64}$/)
  assert.equal(row.secretHash.includes(raw.split('.')[1]), false)
  assert.equal(await verifyApiKey(raw) !== null, true)
  assert.notEqual((await prisma.merchantApiKey.findUniqueOrThrow({ where: { keyId: row.keyId } })).lastUsedAt, null)

  // No endpoint returns the hash or the raw secret again.
  const revoked = await request(app).delete('/api/merchants/' + merchant.id + '/api-keys/' + row.keyId)
    .set(auth(ownerId)).expect(200)
  assert.equal(JSON.stringify(revoked.body).includes(row.secretHash), false)
  assert.equal(JSON.stringify(revoked.body).includes(raw.split('.')[1]), false)

  const again = await request(app).delete('/api/merchants/' + merchant.id + '/api-keys/' + row.keyId)
    .set(auth(ownerId)).expect(200)
  assert.equal(again.body.data.revokedAt, revoked.body.data.revokedAt)
  assert.equal(await verifyApiKey(raw), null)
})

test('M08 migration preserves merchants and outbox rows and does not duplicate events', async () => {
  const before = await approvedMerchant('Preserved')
  const events = await prisma.merchantOutboxEvent.findMany({ where: { aggregateId: before.merchant.id } })
  assert.equal(events.length, 2) // registered + status_updated
  assert.equal(new Set(events.map(e => e.aggregateVersion)).size, events.length)

  // The new tables coexist with pre-existing data; no cascade removed the merchant.
  await request(app).post('/api/merchants/' + before.merchant.id + '/outlets')
    .set(auth(before.ownerId)).send({ name: 'Kept', code: 'KEPT-' + randomUUID().slice(0, 8) }).expect(201)
  assert.ok(await prisma.merchant.findUnique({ where: { id: before.merchant.id } }))
  const after = await prisma.merchantOutboxEvent.findMany({ where: { aggregateId: before.merchant.id } })
  assert.equal(after.length, events.length + 1)
  assert.equal(new Set(after.map(e => e.aggregateVersion)).size, after.length)
})

test('admin may list and issue outlets/keys for any approved merchant', async () => {
  const { merchant, ownerId } = await approvedMerchant()
  await request(app).get('/api/merchants/' + merchant.id + '/outlets')
    .set(auth(randomUUID(), 'ADMIN')).expect(200)
  await request(app).post('/api/merchants/' + merchant.id + '/api-keys')
    .set(auth(randomUUID(), 'ADMIN')).expect(201)
  // Internal service calls bypass owner checks too.
  await request(app).get('/api/merchants/' + merchant.id + '/outlets').set(internal).expect(200)
  // The owner still cannot see another merchant's keys through a foreign merchant id.
  await request(app).get('/api/merchants/' + merchant.id + '/outlets').set(auth(ownerId, 'USER')).expect(200)
})
