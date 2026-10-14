import { createTestGatewayToken } from 'finvault-internal-auth'
import './setup'
import { spawnSync } from 'node:child_process'
import { stub } from './stub'
import { test, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '../src/app'
import { prisma } from '../src/config/prisma'

const userId = '10000000-0000-4000-8000-000000000001'
const resourceId = '20000000-0000-4000-8000-000000000001'
function auth(role = 'USER', id = userId) {
  return { 'x-gateway-token': createTestGatewayToken(id, role) }
}
afterEach(() => mock.restoreAll())
test('missing internal key fails startup instead of using a fallback', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', "require('./src/config/env')"], {
    env: { ...process.env, INTERNAL_KEY: '' }, encoding: 'utf8', windowsHide: true
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Invalid environment: INTERNAL_KEY/)
  assert.equal(result.stderr.includes(process.env.INTERNAL_KEY!), false)
})
test('health is public', async () => { await request(app).get('/health').expect(200) })
test('malformed JSON still has a correlation ID and a consistent error envelope', async () => {
  const response = await request(app).post('/api/users/').set('Content-Type', 'application/json').send('{broken').expect(400)
  assert.equal(response.body.error.code, 'VALIDATION_ERROR')
  assert.equal(response.body.requestId, response.headers['x-request-id'])
})
test('a forged marker and ADMIN header do not authenticate a caller', async () => {
  await request(app).get('/api/users').set({ 'x-gateway-verified': 'true', 'x-user-role': 'ADMIN' }).expect(401)
})
test('role header cannot elevate a signed USER token', async () => {
  await request(app).get('/api/users').set({ ...auth(), 'x-user-role': 'ADMIN' }).expect(403)
})
test('wrong internal key is rejected even with spoofed role', async () => {
  await request(app).get('/api/users').set({ 'x-internal-key': 'wrong', 'x-user-role': 'ADMIN' }).expect(401)
})
test('internal key cannot elevate a Gateway USER or bypass owner checks', async () => {
  const headers = { ...auth(), 'x-internal-key': process.env.INTERNAL_KEY!, 'x-user-role': 'ADMIN' }
  stub(prisma.user, 'update', async () => assert.fail('must not update another user'))
  stub(prisma, '$transaction', async () => assert.fail('must not start a privileged transaction'))
  await request(app).get('/api/users').set(headers).expect(403)
  await request(app).patch('/api/users/' + resourceId + '/kyc-status').set(headers)
    .send({ kycStatus: 'APPROVED' }).expect(403)
  await request(app).post('/api/users').set(headers)
    .send({ authUserId: resourceId, email: 'other@example.com' }).expect(401)
  stub(prisma.user, 'findMany', async () => [{ id: resourceId, authUserId: resourceId, deletedAt: null }])
  for (const path of ['/api/users/' + resourceId, '/api/users/by-auth/' + resourceId]) {
    await request(app).get(path).set(headers).expect(403)
    await request(app).put(path).set(headers).send({ fullName: 'Attacker' }).expect(403)
    await request(app).post(path + '/kyc').set(headers)
      .field('idNumber', '123').attach('document', Buffer.from('invalid'), 'document.png').expect(403)
    await request(app).get(path + '/kyc/document').set(headers).expect(403)
  }
})
test('invalid Gateway token never falls back to a valid internal key', async () => {
  for (const token of ['', 'invalid', createTestGatewayToken(userId, 'ADMIN', 0, -1)]) {
    const response = await request(app).get('/api/users').set({
      'x-gateway-token': token, 'x-internal-key': process.env.INTERNAL_KEY!
    }).expect(401)
    assert.equal(response.body.error.code, 'INVALID_GATEWAY_TOKEN')
  }
})
test('internal calls without a Gateway token still authenticate', async () => {
  stub(prisma.user, 'findMany', async () => [])
  stub(prisma.user, 'count', async () => 0)
  await request(app).get('/api/users').set('x-internal-key', process.env.INTERNAL_KEY!).expect(200)
})
test('Auth can provision a profile using internal credentials', async () => {
  const data = { authUserId: userId, email: 'new@example.com' }
  stub(prisma.user, 'create', async (query) => {
    assert.deepEqual(query.data, data)
    return { id: resourceId, ...data, kycTier: 0 }
  })
  const response = await request(app).post('/api/users')
    .set('x-internal-key', process.env.INTERNAL_KEY!).send(data).expect(201)
  assert.equal(response.body.data.authUserId, userId)
  assert.equal(response.body.message, 'Success')
})
test('signed ADMIN and internal Admin calls can review KYC', async () => {
  const profile = { id: resourceId, authUserId: resourceId, deletedAt: null, version: 0,
    kycStatus: 'PENDING', idNumber: '123', kycObjectKey: 'kyc/private.jpg' }
  stub(prisma.user, 'findMany', async () => [profile])
  let updates = 0
  stub(prisma, '$transaction', async (work) => work({ user: {
    updateMany: async (query: any) => {
      assert.equal(query.where.id, resourceId)
      assert.equal(query.data.kycStatus, 'APPROVED')
      updates++
      return { count: 1 }
    },
    findUniqueOrThrow: async () => ({ ...profile, kycStatus: 'APPROVED', version: 1 })
  } }))
  for (const headers of [
    { ...auth('ADMIN'), 'x-internal-key': process.env.INTERNAL_KEY! },
    { 'x-internal-key': process.env.INTERNAL_KEY! }
  ]) {
    const response = await request(app).patch('/api/users/' + resourceId + '/kyc-status')
      .set(headers).send({ kycStatus: 'APPROVED' }).expect(200)
    assert.equal(response.body.data.kycStatus, 'APPROVED')
    assert.equal(response.body.data.kycObjectKey, undefined)
  }
  assert.equal(updates, 2)
})
test('expired and wrong-signature tokens are rejected', async () => {
  for (const token of [
    createTestGatewayToken(userId, 'ADMIN', 0, -1),
    jwt.sign({ userId, role: 'ADMIN' }, 'wrong-secret')
  ]) await request(app).get('/api/users').set({ 'x-gateway-token': token }).expect(401)
})
test('invalid pagination is rejected before database access', async () => {
  for (const query of ['page=0', 'limit=-1', 'page=abc', 'limit=101', 'page=1.5', 'page=1&page=2'])
    await request(app).get('/api/users?' + query).set(auth('ADMIN')).expect(400)
})
test('invalid resource ID is rejected', async () => {
  await request(app).get('/api/users/invalid').set(auth()).expect(400)
})
test('database errors do not disclose connection details', async () => {
  stub(prisma.user, 'findMany', async () => { throw new Error('postgresql://SECRET@example/private') })
  const response = await request(app).get('/api/users/' + resourceId).set(auth()).expect(500)
  assert.equal(response.body.error.message, 'Internal server error')
  assert.equal(JSON.stringify(response.body).includes('SECRET'), false)
  assert.ok(response.headers['x-request-id'])
})
