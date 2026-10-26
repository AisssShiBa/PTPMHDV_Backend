import './setup'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import app from '../src/app'
import { authenticateServiceRequest } from '../src/middlewares/authenticateServiceRequest'
import express from 'express'
import { createTestGatewayToken } from 'finvault-internal-auth'
import jwt from 'jsonwebtoken'
import { PinService } from '../src/services/pinService'

const userId = '11111111-1111-4111-8111-111111111111'
const otherUserId = '22222222-2222-4222-8222-222222222222'
const pinPaths = ['/api/auth-txn/pin', '/api/auth/pin']

test('missing internal key fails startup instead of using a fallback (B3)', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', "require('./src/config/env')"], {
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, INTERNAL_KEY: '', INTERNAL_API_KEY: '' },
    encoding: 'utf8',
    windowsHide: true
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Thiếu biến môi trường bắt buộc: INTERNAL_KEY/)
})

test('health is public', async () => {
  await request(app).get('/health').expect(200)
  await request(app).get('/api/auth/health').expect(200)
})

test('sending x-gateway-verified: true straight into Auth returns 401 (B1)', async () => {
  const response = await request(app)
    .post('/api/auth/signup')
    .set({ 'x-gateway-verified': 'true' })
    .send({ username: 'attacker' })
    .expect(401)
  assert.equal(response.body.error.code, 'INVALID_GATEWAY_TOKEN')
})

test('authenticateServiceRequest rejects invalid internal key with 401', async () => {
  const testApp = express()
  testApp.use(express.json())
  testApp.get('/test-internal', authenticateServiceRequest, (_req, res) => {
    res.json({ ok: true })
  })

  await request(testApp)
    .get('/test-internal')
    .set({ 'x-internal-key': 'wrong-key-01234567890123456789' })
    .expect(401)
})

test('authenticateServiceRequest accepts valid internal key', async () => {
  const testApp = express()
  testApp.use(express.json())
  testApp.get('/test-internal', authenticateServiceRequest, (req: any, res) => {
    res.json({ ok: true, isInternalCall: req.isInternalCall })
  })

  const response = await request(testApp)
    .get('/test-internal')
    .set({ 'x-internal-key': process.env.INTERNAL_KEY! })
    .expect(200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.isInternalCall, true)
})

test('public signup still reaches validation without a Gateway token', async () => {
  await request(app).post('/api/auth/signup').send({}).expect(400)
})

for (const path of pinPaths) {
  test(`${path} uses signed identity for every PIN operation despite spoofed headers`, async t => {
    const calls: string[] = []
    const operations = [
      { route: 'setup', method: 'setupPin' as const, status: 201, body: { pin: '123456', confirmPin: '123456' } },
      { route: 'verify', method: 'verifyPin' as const, status: 200, body: { pin: '123456', paymentId: 'payment-test', amount: '1000' } },
      { route: 'change', method: 'changePin' as const, status: 200, body: { oldPin: '123456', newPin: '654321', confirmNewPin: '654321' } }
    ]
    const headers = {
      'x-gateway-token': createTestGatewayToken(userId),
      'x-internal-key': process.env.INTERNAL_KEY!,
      'x-user-id': otherUserId,
      'x-user-role': 'ADMIN'
    }
    for (const operation of operations) {
      t.mock.method(PinService, operation.method, async (id: string) => {
        calls.push(id)
        return { message: 'ok' }
      })
      await request(app).post(`${path}/${operation.route}`).set(headers).send(operation.body).expect(operation.status)
    }
    t.mock.method(PinService, 'getPinStatus', async (id: string) => {
      calls.push(id)
      return { hasPin: false }
    })
    await request(app).get(`${path}/status`).set(headers).expect(200)
    assert.deepEqual(calls, [userId, userId, userId, userId])
  })

  test(`${path} rejects untrusted credentials before reaching PIN services`, async t => {
    const handler = t.mock.method(PinService, 'getPinStatus', async () => ({ hasPin: false }))
    const accessToken = jwt.sign({ userId, role: 'USER' }, process.env.ACCESS_TOKEN_SECRET!)
    const invalidHeaders = [
      {},
      { 'x-user-id': userId },
      { authorization: `Bearer ${accessToken}` },
      { 'x-gateway-verified': 'true', 'x-user-id': userId },
      { 'x-internal-key': 'wrong-key', 'x-user-id': userId },
      { 'x-internal-key': process.env.INTERNAL_KEY! },
      { 'x-internal-key': process.env.INTERNAL_KEY!, 'x-user-id': 'invalid-id' },
      { 'x-gateway-token': 'invalid', 'x-internal-key': process.env.INTERNAL_KEY!, 'x-user-id': userId },
      { 'x-gateway-token': createTestGatewayToken(userId, 'USER', 0, '-1s') }
    ]
    for (const headers of invalidHeaders) {
      await request(app).get(`${path}/status`).set(headers).expect(401)
    }
    assert.equal(handler.mock.callCount(), 0)
  })

  test(`${path} accepts an internal caller only with a valid key and user identity`, async t => {
    const handler = t.mock.method(PinService, 'getPinStatus', async (id: string) => {
      assert.equal(id, userId)
      return { hasPin: false }
    })
    await request(app).get(`${path}/status`).set({
      'x-internal-key': process.env.INTERNAL_KEY!,
      'x-user-id': userId
    }).expect(200)
    assert.equal(handler.mock.callCount(), 1)
  })
}
