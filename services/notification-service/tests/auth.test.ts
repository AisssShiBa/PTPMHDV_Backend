import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { createTestGatewayToken } from 'finvault-internal-auth'
import app from '../src/app'

let server: ReturnType<typeof app.listen>
let baseUrl: string

before(async () => {
  server = app.listen(0)
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
})

const getNotifications = (headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}/api/notifications/me`, { headers })

test('auth package smoke test creates a Gateway Token', () => {
  assert.equal(typeof createTestGatewayToken('00000000-0000-4000-8000-000000000001'), 'string')
})

test('notification client route rejects missing Gateway Token', async () => {
  const response = await getNotifications()
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error.code, 'INVALID_GATEWAY_TOKEN')
})

test('socket ticket endpoint rejects a missing Gateway Token', async () => {
  const response = await fetch(`${baseUrl}/api/notifications/socket-ticket`)
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error.code, 'INVALID_GATEWAY_TOKEN')
})

test('socket ticket endpoint returns the verified request Gateway Token', async () => {
  const token = createTestGatewayToken('00000000-0000-4000-8000-000000000002')
  const response = await fetch(`${baseUrl}/api/notifications/socket-ticket`, {
    headers: { 'x-gateway-token': token }
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    success: true,
    data: { ticket: token }
  })
})

test('notification client route rejects expired Gateway Token', async () => {
  const token = createTestGatewayToken('00000000-0000-4000-8000-000000000003', 'USER', 0, '-1s')
  const response = await getNotifications({ 'x-gateway-token': token })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error.code, 'INVALID_GATEWAY_TOKEN')
})

test('notification client route rejects a forged Gateway Token', async () => {
  const response = await getNotifications({ 'x-gateway-token': 'not-a-valid-token' })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error.code, 'INVALID_GATEWAY_TOKEN')
})

test('legacy verification header cannot authenticate client requests', async () => {
  const response = await getNotifications({
    'x-gateway-verified': 'true',
    'x-user-id': 'user-a'
  })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error.code, 'INVALID_GATEWAY_TOKEN')
})

test('internal key cannot authenticate client requests', async () => {
  const response = await fetch(`${baseUrl}/api/notifications/socket-ticket`, {
    headers: { 'x-internal-key': process.env.INTERNAL_KEY ?? '' }
  })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error.code, 'INVALID_GATEWAY_TOKEN')
})

test('a forged user ID header cannot authenticate client requests', async () => {
  const response = await getNotifications({ 'x-user-id': 'user-b' })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error.code, 'INVALID_GATEWAY_TOKEN')
})

test('internal notification creation still requires x-internal-key', async () => {
  const response = await fetch(`${baseUrl}/api/notifications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-key': 'wrong-key' },
    body: JSON.stringify({
      userId: 'user-a',
      type: 'PAYMENT_SUCCESS',
      message: 'Thanh toán thành công.'
    })
  })
  assert.equal(response.status, 401)
})

test('health endpoints remain public', async () => {
  const health = await fetch(`${baseUrl}/health`)
  const notificationHealth = await fetch(`${baseUrl}/api/notifications/health`)
  assert.equal(health.status, 200)
  assert.equal(notificationHealth.status, 200)
})
