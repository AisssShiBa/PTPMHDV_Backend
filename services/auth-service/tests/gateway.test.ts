import './setup'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { generateKeyPairSync } from 'node:crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '../src/app'
import { PinService } from '../src/services/pinService'

test('real Gateway forwards both PIN aliases with signed identity and strips spoofed credentials', { timeout: 20000 }, async t => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const previousEnv = { ...process.env }
  process.env.GATEWAY_PRIVATE_KEY = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  process.env.GATEWAY_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  delete process.env.GATEWAY_PRIVATE_KEY_FILE
  const userId = '11111111-1111-4111-8111-111111111111'
  const handler = t.mock.method(PinService, 'getPinStatus', async (id: string) => {
    assert.equal(id, userId)
    return { hasPin: false }
  })
  const server = app.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    process.env.AUTH_SERVICE_URL = `http://127.0.0.1:${address.port}`
    const gateway = require('../../../gateway/src/app').default
    const bearer = 'Bearer ' + jwt.sign({ userId, role: 'USER' }, process.env.ACCESS_TOKEN_SECRET!, { expiresIn: '5m' })
    for (const path of ['/api/auth/pin/status', '/api/auth-txn/pin/status']) {
      const response = await request(gateway).get(path).set({
        authorization: bearer,
        'x-gateway-token': 'forged-token',
        'x-gateway-verified': 'true',
        'x-internal-key': 'wrong-key',
        'x-user-id': 'spoofed-user',
        'x-user-role': 'ADMIN'
      }).expect(200)
      assert.equal(response.body.data.hasPin, false)
      await request(gateway).get(path).set('x-internal-key', process.env.INTERNAL_KEY!).expect(401)
    }
    assert.equal(handler.mock.callCount(), 2)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    for (const key of ['GATEWAY_PRIVATE_KEY', 'GATEWAY_PUBLIC_KEY', 'GATEWAY_PRIVATE_KEY_FILE', 'AUTH_SERVICE_URL']) {
      if (previousEnv[key] === undefined) delete process.env[key]
      else process.env[key] = previousEnv[key]
    }
  }
})
