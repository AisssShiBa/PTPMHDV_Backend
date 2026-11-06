import { createTestGatewayToken } from 'finvault-internal-auth'
import './setup'
import { stub } from './stub'
import { test } from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import request from 'supertest'
import app from '../src/app'
import { prisma } from '../src/config/prisma'
import { issueApiKey, revokeApiKey, verifyApiKey } from '../src/services/merchant-api-key.service'

const ownerId = '10000000-0000-4000-8000-000000000001'
const otherOwner = '10000000-0000-4000-8000-000000000002'
const merchantId = '20000000-0000-4000-8000-000000000001'
const keyId = '40000000-0000-4000-8000-000000000001'
const auth = (userId = ownerId) => ({ 'x-gateway-token': createTestGatewayToken(userId) })
const merchant = { id: merchantId, ownerId, businessName: 'Shop', status: 'APPROVED', version: 1, deletedAt: null }
const record = (overrides: Record<string, unknown> = {}) => ({
  id: '50000000-0000-4000-8000-000000000001', merchantId, keyId,
  prefix: 'abcdefgh', secretHash: 'a'.repeat(64), revokedAt: null, lastUsedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'), ...overrides
})

test('M06 the raw secret appears once at creation and only its hash is stored', async () => {
  stub(prisma.merchant, 'findFirst', async () => merchant)
  let persisted: any
  stub(prisma.merchantApiKey, 'create', async (args: any) => { persisted = args.data; return record(args.data) })
  const res = await request(app).post('/api/merchants/' + merchantId + '/api-keys').set(auth()).expect(201)
  assert.equal(res.headers['cache-control'], 'no-store')
  const raw = res.body.data.key as string
  const [returnedKeyId, secret] = raw.split('.')
  assert.equal(returnedKeyId, persisted.keyId)
  assert.equal(Buffer.from(secret, 'base64url').length, 32) // 256 bits of entropy
  assert.equal(persisted.secretHash, createHash('sha256').update(secret).digest('hex'))
  assert.equal(JSON.stringify(res.body).includes(persisted.secretHash), false)
  assert.equal(JSON.stringify(res.body).includes(secret), true) // exactly once, in this response
  assert.equal(persisted.secretHash.includes(secret), false)
})

test('M07 revoke is idempotent, hides the secret and blocks verification', async () => {
  const raw = 'test-key.' + randomBytes(32).toString('base64url')
  const hash = createHash('sha256').update(raw.split('.')[1]).digest('hex')
  stub(prisma.merchantApiKey, 'findFirst', async () => record({ keyId: 'test-key', secretHash: hash }))
  stub(prisma.merchantApiKey, 'updateMany', async () => ({ count: 1 }))
  stub(prisma.merchantApiKey, 'update', async (args: any) => record({ keyId: 'test-key', secretHash: hash, ...args.data }))
  assert.ok(await verifyApiKey(raw))

  const first = await revokeApiKey(merchantId, 'test-key')
  assert.ok(first.revokedAt)
  stub(prisma.merchantApiKey, 'findFirst', async () => record({ keyId: 'test-key', secretHash: hash, revokedAt: first.revokedAt }))
  const second = await revokeApiKey(merchantId, 'test-key')
  assert.deepEqual(second.revokedAt, first.revokedAt) // repeated revoke keeps the original time
  assert.equal(JSON.stringify(second).includes('test-key.' + raw.split('.')[1]), false)

  // A revoked key never authenticates.
  stub(prisma.merchantApiKey, 'findFirst', async () => null)
  assert.equal(await verifyApiKey(raw), null)
})

test('a non-matching secret never verifies and never marks lastUsedAt', async () => {
  const secret = randomBytes(32).toString('base64url')
  const hash = createHash('sha256').update(secret).digest('hex')
  let used = 0
  stub(prisma.merchantApiKey, 'findFirst', async () => record({ keyId: 'k1', secretHash: hash }))
  stub(prisma.merchantApiKey, 'updateMany', async () => { used++; return { count: 1 } })
  assert.equal(await verifyApiKey('k1.' + randomBytes(32).toString('base64url')), null)
  assert.equal(used, 0)
  assert.ok(await verifyApiKey('k1.' + secret))
  assert.equal(used, 1)
})

test('issueApiKey derives keyId and hash server-side', async () => {
  let persisted: any
  stub(prisma.merchantApiKey, 'create', async (args: any) => { persisted = args.data; return record(args.data) })
  const key = await issueApiKey(merchantId)
  assert.equal(persisted.merchantId, merchantId)
  assert.match(persisted.keyId, /^[0-9a-f-]{36}$/)
  assert.equal(persisted.keyId, key.keyId)
  assert.match(persisted.secretHash, /^[a-f0-9]{64}$/)
  assert.equal(persisted.prefix.length, 8)
})

test('M03 another owner cannot issue or revoke keys', async () => {
  stub(prisma.merchant, 'findFirst', async () => merchant)
  await request(app).post('/api/merchants/' + merchantId + '/api-keys').set(auth(otherOwner)).expect(403)
  await request(app).delete('/api/merchants/' + merchantId + '/api-keys/' + keyId).set(auth(otherOwner)).expect(403)
})

test('revoking an unknown key answers 404 without leaking anything', async () => {
  stub(prisma.merchant, 'findFirst', async () => merchant)
  stub(prisma.merchantApiKey, 'findFirst', async () => null)
  const res = await request(app).delete('/api/merchants/' + merchantId + '/api-keys/' + keyId).set(auth()).expect(404)
  assert.equal(res.body.error.code, 'NOT_FOUND')
})
