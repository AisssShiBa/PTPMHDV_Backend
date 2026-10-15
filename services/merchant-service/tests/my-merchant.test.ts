import { createTestGatewayToken } from 'finvault-internal-auth'
import './setup'
import { stub } from './stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import app from '../src/app'
import { prisma } from '../src/config/prisma'

const ownerId = '10000000-0000-4000-8000-000000000001'
const otherOwner = '10000000-0000-4000-8000-000000000002'
const headers = {
  'x-gateway-token': createTestGatewayToken(ownerId)
}

test('me resolves the verified owner and ignores spoofed owner identity', async () => {
  const merchant = { id: '20000000-0000-4000-8000-000000000001', ownerId, businessName: 'Shop', status: 'PENDING' }
  stub(prisma.merchant, 'findFirst', async (args) => {
    assert.deepEqual(args.where, { ownerId, deletedAt: null })
    return merchant
  })
  const res = await request(app).get('/api/merchants/me?ownerId=' + otherOwner)
    .set({ ...headers, 'x-user-id': otherOwner, 'x-internal-key': process.env.INTERNAL_KEY! }).expect(200)
  assert.deepEqual(res.body, { success: true, message: 'Success', data: merchant })
})

test('me returns explicit null when owner has no active record', async () => {
  stub(prisma.merchant, 'findFirst', async () => null)
  const res = await request(app).get('/api/merchants/me').set(headers).expect(200)
  assert.deepEqual(res.body, { success: true, message: 'Success', data: null })
})

test('me requires a valid token', async () => {
  await request(app).get('/api/merchants/me').set('x-gateway-verified', 'true').expect(401)
  await request(app).get('/api/merchants/me').set({ ...headers, 'x-gateway-token': 'invalid' }).expect(401)
})

test('me does not turn a database outage into no registration', async () => {
  stub(prisma.merchant, 'findFirst', async () => { throw new Error('Database unavailable') })
  const res = await request(app).get('/api/merchants/me').set(headers).expect(500)
  assert.equal(res.body.success, false)
  assert.equal(res.body.data, undefined)
})
