import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTestGatewayToken } from 'finvault-internal-auth'
import { clientAuth } from '../src/middlewares/clientAuth'
import { once } from 'node:events'

process.env.NODE_ENV = 'test'
delete process.env.GATEWAY_PUBLIC_KEY_FILE
delete process.env.GATEWAY_PUBLIC_KEY
const userId = '10000000-0000-4000-8000-000000000001'
function authenticate(headers: Record<string, string>) {
  const req: any = { headers, userId: 'stale-identity' }
  let status = 200, body: any, accepted = false
  const res: any = { status(value: number) { status = value; return this },
    json(value: any) { body = value; return this }, getHeader() { return 'test-request' } }
  clientAuth(req, res, () => { accepted = true })
  return { req, status, body, accepted }
}
test('HTTP notifications take identity from verified Gateway claims', () => {
  const result = authenticate({ 'x-gateway-token': createTestGatewayToken(userId), 'x-user-id': 'spoofed' })
  assert.equal(result.accepted, true)
  assert.equal(result.req.userId, userId)
})
test('legacy marker and forged identity no longer authenticate notifications', () => {
  const result = authenticate({ 'x-gateway-verified': 'true', 'x-user-id': userId })
  assert.equal(result.status, 401)
  assert.equal(result.accepted, false)
  assert.equal(result.req.userId, undefined)
})
test('invalid or expired token cannot use an internal key as a fallback', () => {
  for (const token of ['invalid', createTestGatewayToken(userId, 'USER', 0, -1)]) {
    const result = authenticate({ 'x-gateway-token': token, 'x-internal-key': 'internal' })
    assert.equal(result.status, 401)
    assert.equal(result.body.error.code, 'INVALID_GATEWAY_TOKEN')
    assert.equal(result.accepted, false)
  }
})
test('HTTP routes accept signed clients and keep internal writes separate', async () => {
  process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/unused'
  process.env.INTERNAL_KEY = 'notification-internal-test-key-0123456789'
  process.env.ACCESS_TOKEN_SECRET = 'notification-access-test-key-0123456789'
  const { default: app } = await import('../src/app')
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  try {
    const other = '10000000-0000-4000-8000-000000000002'
    // Reaches the self-access guard without querying a database.
    const signed = await fetch(base + '/api/notifications/' + other,
      { headers: { 'x-gateway-token': createTestGatewayToken(userId) } })
    assert.equal(signed.status, 403)
    const forged = await fetch(base + '/api/notifications/' + userId,
      { headers: { 'x-gateway-verified': 'true', 'x-user-id': userId } })
    assert.equal(forged.status, 401)
    const clientWrite = await fetch(base + '/api/notifications', { method: 'POST',
      headers: { 'x-gateway-token': createTestGatewayToken(userId), 'content-type': 'application/json' }, body: '{}' })
    assert.equal(clientWrite.status, 401)
    const internalWrite = await fetch(base + '/api/notifications', { method: 'POST',
      headers: { 'x-internal-key': process.env.INTERNAL_KEY, 'content-type': 'application/json' }, body: '{}' })
    assert.equal(internalWrite.status, 400)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
