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
  return { 'x-gateway-verified': 'true', authorization: 'Bearer ' + jwt.sign({ userId: id, role }, process.env.ACCESS_TOKEN_SECRET!, { expiresIn: '5m' }) }
}
afterEach(() => mock.restoreAll())
test('missing internal key fails startup instead of using a fallback', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', "require('./src/config/env')"], {
    env: { ...process.env, INTERNAL_KEY: '' }, encoding: 'utf8', windowsHide: true
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Invalid environment: INTERNAL_KEY/)
  assert.equal(result.stderr.includes(process.env.ACCESS_TOKEN_SECRET!), false)
})
test('health is public', async () => { await request(app).get('/health').expect(200) })
test('malformed JSON still has a correlation ID and a consistent error envelope', async () => {
  const response = await request(app).post('/api/merchants/').set('Content-Type', 'application/json').send('{broken').expect(400)
  assert.equal(response.body.error.code, 'VALIDATION_ERROR')
  assert.equal(response.body.requestId, response.headers['x-request-id'])
})
test('a forged marker and ADMIN header do not authenticate a caller', async () => {
  await request(app).get('/api/merchants').set({ 'x-gateway-verified': 'true', 'x-user-role': 'ADMIN' }).expect(401)
})
test('role header cannot elevate a signed USER token', async () => {
  await request(app).get('/api/merchants').set({ ...auth(), 'x-user-role': 'ADMIN' }).expect(403)
})
test('wrong internal key is rejected even with spoofed role', async () => {
  await request(app).get('/api/merchants').set({ 'x-internal-key': 'wrong', 'x-user-role': 'ADMIN' }).expect(401)
})
test('expired and wrong-signature tokens are rejected', async () => {
  for (const token of [
    jwt.sign({ userId, role: 'ADMIN' }, process.env.ACCESS_TOKEN_SECRET!, { expiresIn: -1 }),
    jwt.sign({ userId, role: 'ADMIN' }, 'wrong-secret')
  ]) await request(app).get('/api/merchants').set({ 'x-gateway-verified': 'true', authorization: 'Bearer ' + token }).expect(401)
})
test('invalid pagination is rejected before database access', async () => {
  for (const query of ['page=0', 'limit=-1', 'page=abc', 'limit=101', 'page=1.5', 'page=1&page=2'])
    await request(app).get('/api/merchants?' + query).set(auth('ADMIN')).expect(400)
})
test('invalid resource ID is rejected', async () => {
  await request(app).get('/api/merchants/invalid').set(auth()).expect(400)
})
test('database errors do not disclose connection details', async () => {
  stub(prisma.merchant, 'findFirst', async () => { throw new Error('postgresql://SECRET@example/private') })
  const response = await request(app).get('/api/merchants/' + resourceId).set(auth()).expect(500)
  assert.equal(response.body.error.message, 'Internal server error')
  assert.equal(JSON.stringify(response.body).includes('SECRET'), false)
  assert.ok(response.headers['x-request-id'])
})
