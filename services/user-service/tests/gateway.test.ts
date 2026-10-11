import './setup'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { generateKeyPairSync } from 'node:crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import userApp from '../src/app'
import { prisma as users } from '../src/config/prisma'
import { stub } from './stub'

test('real Gateway proxy reaches both services and strips client internal credentials', { timeout: 20000 }, async () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  process.env.GATEWAY_PRIVATE_KEY = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  process.env.GATEWAY_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  delete process.env.GATEWAY_PRIVATE_KEY_FILE
  process.env.ACCESS_TOKEN_SECRET = 'gateway-integration-access-secret-0123456789'
  const merchantApp = require('../../merchant-service/src/app').default
  const merchants = require('../../merchant-service/src/config/prisma').prisma
  const userId = '10000000-0000-4000-8000-000000000001'
  stub(users.user, 'findMany', async (query: any) => {
    assert.equal(query.where.authUserId, userId)
    return [{ id: '20000000-0000-4000-8000-000000000001', authUserId: userId, deletedAt: null, kycTier: 0 }]
  })
  stub(merchants.merchant, 'findFirst', async (query: any) => {
    assert.equal(query.where.ownerId, userId)
    return null
  })
  const servers = [userApp.listen(0, '127.0.0.1'), merchantApp.listen(0, '127.0.0.1')]
  try {
    await Promise.all(servers.map(server => once(server, 'listening')))
    process.env.USER_SERVICE_URL = 'http://127.0.0.1:' + (servers[0].address() as any).port
    process.env.MERCHANT_SERVICE_URL = 'http://127.0.0.1:' + (servers[1].address() as any).port
    const gateway = require('../../../gateway/src/app').default
    const bearer = 'Bearer ' + jwt.sign({ userId, role: 'USER' }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '5m' })
    for (const path of ['/api/users/me', '/api/merchants/me']) {
      const response = await request(gateway).get(path).set('Authorization', bearer)
        .set('x-internal-key', 'invalid-client-key').set('x-user-role', 'ADMIN')
        .set('x-user-id', 'spoofed').set('x-gateway-token', 'spoofed').expect(200)
      assert.equal(response.body.success, true)
    }
    // Even a valid shared key submitted through the public Gateway cannot bypass RBAC.
    for (const path of ['/api/users', '/api/merchants']) {
      await request(gateway).get(path).set('Authorization', bearer)
        .set('x-internal-key', process.env.INTERNAL_KEY!).set('x-user-role', 'ADMIN').expect(403)
      await request(gateway).get(path).set('x-internal-key', process.env.INTERNAL_KEY!)
        .set('x-gateway-verified', 'true').expect(401)
    }
    for (const [app, path] of [[userApp, '/api/users/me'], [merchantApp, '/api/merchants/me']]) {
      const response = await request(app).get(path).set('Authorization', bearer).expect(401)
      assert.equal(response.body.error.code, 'INVALID_GATEWAY_TOKEN')
      assert.equal(response.body.requestId, response.headers['x-request-id'])
    }
  } finally {
    servers.forEach(server => server.closeAllConnections())
    await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))))
    delete process.env.GATEWAY_PRIVATE_KEY
    delete process.env.GATEWAY_PUBLIC_KEY
  }
})
