import { createTestGatewayToken } from 'finvault-internal-auth'
import './setup'
import { stub } from './stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import app from '../src/app'
import { prisma } from '../src/config/prisma'
import { verifyOutletQr } from '../src/services/qr.service'

const ownerId = '10000000-0000-4000-8000-000000000001'
const otherOwner = '10000000-0000-4000-8000-000000000002'
const merchantId = '20000000-0000-4000-8000-000000000001'
const otherMerchantId = '20000000-0000-4000-8000-000000000002'
const outletId = '30000000-0000-4000-8000-000000000001'
const auth = (userId = ownerId, role = 'USER') => ({ 'x-gateway-token': createTestGatewayToken(userId, role) })

function merchant(overrides: Record<string, unknown> = {}) {
  return { id: merchantId, ownerId, businessName: 'Shop', status: 'APPROVED', version: 3, deletedAt: null, ...overrides }
}

// Runs the callback against the same client so service code sees the stubs.
function runTransaction() {
  stub(prisma, '$transaction', (callback: any) => callback(prisma))
  stub(prisma.merchantOutboxEvent, 'create', async (args: any) => args.data)
}

test('M01 approved owner creates an outlet and lists only that merchant', async () => {
  runTransaction()
  stub(prisma.merchant, 'findFirst', async () => merchant())
  stub(prisma.outlet, 'create', async (args: any) => ({ id: outletId, ...args.data }))
  stub(prisma.merchant, 'update', async () => merchant({ version: 4 }))
  const created = await request(app).post('/api/merchants/' + merchantId + '/outlets')
    .set(auth()).send({ name: 'Quan 1', code: 'Q1-COUNTER' }).expect(201)
  assert.equal(created.body.data.code, 'Q1-COUNTER')
  assert.equal(created.body.data.merchantId, merchantId)

  stub(prisma.outlet, 'findMany', async (args: any) => {
    assert.equal(args.where.merchantId, merchantId)
    return [{ id: outletId, merchantId, name: 'Quan 1', code: 'Q1-COUNTER' }]
  })
  stub(prisma.outlet, 'count', async () => 1)
  const list = await request(app).get('/api/merchants/' + merchantId + '/outlets').set(auth()).expect(200)
  assert.equal(list.body.data.totalElements, 1)
  assert.equal(JSON.stringify(list.body).includes('secretHash'), false)
})

test('M02 outlets and API keys are refused unless the merchant is APPROVED', async () => {
  runTransaction()
  for (const status of ['PENDING', 'REJECTED']) {
    stub(prisma.merchant, 'findFirst', async () => merchant({ status }))
    const create = await request(app).post('/api/merchants/' + merchantId + '/outlets')
      .set(auth()).send({ name: 'Quan 1', code: 'Q1-' + status }).expect(409)
    assert.equal(create.body.error.code, 'MERCHANT_NOT_APPROVED')
    const key = await request(app).post('/api/merchants/' + merchantId + '/api-keys').set(auth()).expect(409)
    assert.equal(key.body.error.code, 'MERCHANT_NOT_APPROVED')
    const qr = await request(app).get('/api/merchants/' + merchantId + '/outlets/' + outletId + '/qr').set(auth()).expect(409)
    assert.equal(qr.body.error.code, 'MERCHANT_NOT_APPROVED')
  }
})

test('M03 another owner is denied; ADMIN is allowed by contract', async () => {
  stub(prisma.merchant, 'findFirst', async () => merchant())
  const path = '/api/merchants/' + merchantId + '/outlets'
  await request(app).post(path).set(auth(otherOwner)).send({ name: 'x', code: 'XYZ1' }).expect(403)
  await request(app).get(path).set(auth(otherOwner)).expect(403)
  await request(app).delete('/api/merchants/' + merchantId + '/api-keys/' + '40000000-0000-4000-8000-000000000001')
    .set(auth(otherOwner)).expect(403)

  stub(prisma.outlet, 'findMany', async () => [])
  stub(prisma.outlet, 'count', async () => 0)
  await request(app).get(path).set(auth(otherOwner, 'ADMIN')).expect(200)
})

test('M05 QR signature covers every field and cannot be replayed for another merchant', async () => {
  stub(prisma.merchant, 'findFirst', async () => merchant())
  stub(prisma.outlet, 'findFirst', async (args: any) => {
    assert.equal(args.where.merchantId, merchantId)
    return { id: outletId, merchantId, name: 'Quan 1', code: 'Q1-COUNTER' }
  })
  const res = await request(app).get('/api/merchants/' + merchantId + '/outlets/' + outletId + '/qr').set(auth()).expect(200)
  assert.equal(res.headers['cache-control'], 'no-store')
  const payload = verifyOutletQr(res.body.data.token, { merchantId, outletId })
  assert.ok(payload)
  assert.equal(payload!.outletCode, 'Q1-COUNTER')

  const [body, signature] = res.body.data.token.split('.')
  const canonical = Buffer.from(body, 'base64url').toString('utf8')
  assert.deepEqual(canonical.split('|').slice(0, 4), ['1', merchantId, outletId, 'Q1-COUNTER'])

  // Alter one signed byte: the HMAC must reject it.
  const tampered = Buffer.from(canonical.replace('Q1-COUNTER', 'Q1-COUNTE2'), 'utf8').toString('base64url')
  assert.equal(verifyOutletQr(tampered + '.' + signature), null)
  // A genuine token never verifies for another merchant, another outlet, or a truncated form.
  assert.equal(verifyOutletQr(res.body.data.token, { merchantId: otherMerchantId }), null)
  assert.equal(verifyOutletQr(res.body.data.token, { merchantId, outletId: '30000000-0000-4000-8000-000000000009' }), null)
  assert.equal(verifyOutletQr(res.body.data.token.slice(0, -2)), null)
})

test('an outletId from another merchant does not resolve', async () => {
  stub(prisma.merchant, 'findFirst', async () => merchant())
  stub(prisma.outlet, 'findFirst', async () => null)
  await request(app).get('/api/merchants/' + merchantId + '/outlets/' + outletId + '/qr').set(auth()).expect(404)
})

test('outlet codes reject characters that would break the canonical QR form', async () => {
  stub(prisma.merchant, 'findFirst', async () => merchant())
  for (const code of ['has|pipe', 'has space', ''])
    await request(app).post('/api/merchants/' + merchantId + '/outlets').set(auth()).send({ name: 'x', code }).expect(400)
})
