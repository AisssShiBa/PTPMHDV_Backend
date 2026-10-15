import { createTestGatewayToken } from 'finvault-internal-auth'
import './setup'
import { stub } from './stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import app from '../src/app'
import { prisma } from '../src/config/prisma'
const owner = '10000000-0000-4000-8000-000000000001'
const id = '20000000-0000-4000-8000-000000000001'
const profile = { id, authUserId: owner, email: 'me@example.com', kycStatus: 'PENDING', kycTier: 0,
  deletedAt: null, kycObjectKey: 'kyc/private.jpg', idImageUrl: 'private-url' }
const headers = { 'x-gateway-token': createTestGatewayToken(owner, 'USER') }

test('me uses signed Auth ID rather than profile ID or spoofed query/header identity', async () => {
  stub(prisma.user, 'findMany', async (query: any) => {
    assert.deepEqual(query.where, { authUserId: owner })
    return [profile]
  })
  const result = await request(app).get('/api/users/me?authUserId=' + id)
    .set({ ...headers, 'x-user-id': id, 'x-internal-key': process.env.INTERNAL_KEY! }).expect(200)
  assert.equal(result.body.data.id, id)
  assert.equal(result.body.data.kycTier, 0)
  assert.equal(result.body.data.hasKycDocument, true)
  assert.equal(result.body.data.kycObjectKey, undefined)
  assert.equal(result.body.data.idImageUrl, undefined)
  const kyc = await request(app).get('/api/users/me/kyc').set(headers).expect(200)
  assert.deepEqual(kyc.body.data, { kycStatus: 'PENDING', kycTier: 0, hasKycDocument: true })
})

test('me requires identity and distinguishes absent/deleted profiles from DB errors', async () => {
  await request(app).get('/api/users/me').set({ 'x-gateway-verified': 'true' }).expect(401)
  await request(app).get('/api/users/me').set({ 'x-internal-key': process.env.INTERNAL_KEY! }).expect(401)
  stub(prisma.user, 'findMany', async () => [])
  await request(app).get('/api/users/me').set(headers).expect(404)
  stub(prisma.user, 'findMany', async () => [{ ...profile, deletedAt: new Date() }])
  await request(app).get('/api/users/me/kyc').set(headers).expect(404)
  stub(prisma.user, 'findMany', async () => { throw new Error('DB unavailable') })
  await request(app).get('/api/users/me').set(headers).expect(500)
})

test('me KYC authorizes before upload and does not allow tier or status assignment', async () => {
  stub(prisma.user, 'findMany', async () => [])
  await request(app).post('/api/users/me/kyc').set(headers).attach('document', Buffer.from('bad'), 'bad.png').expect(404)
  stub(prisma.user, 'findMany', async () => [profile])
  await request(app).post('/api/users/me/kyc').set(headers).send({ idNumber: '123', kycTier: 2 }).expect(400)
  await request(app).post('/api/users/me/kyc').set(headers).send({ idNumber: '123', kycStatus: 'APPROVED' }).expect(400)
  await request(app).put('/api/users/by-auth/' + owner).set(headers).send({ kycTier: 2 }).expect(400)
})
