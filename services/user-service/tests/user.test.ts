import './setup'
import { stub } from './stub'
import { test, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import sharp from 'sharp'
import app from '../src/app'
import { prisma } from '../src/config/prisma'
import { normalizeImage } from '../src/services/kyc.service'
const owner = '10000000-0000-4000-8000-000000000001'
const other = '10000000-0000-4000-8000-000000000002'
const id = '20000000-0000-4000-8000-000000000001'
const profile = { id, authUserId: owner, email: 'a@example.com', deletedAt: null, kycStatus: 'NONE', version: 0 }
const headers = (userId = owner) => ({ 'x-gateway-verified': 'true', authorization: 'Bearer ' + jwt.sign({ userId, role: 'USER' }, process.env.ACCESS_TOKEN_SECRET!) })
afterEach(() => mock.restoreAll())
test('GET resolves both profile ID and Auth ID and hides storage keys', async () => {
  stub(prisma.user, 'findMany', async () => [{ ...profile, kycObjectKey: 'private/key', idImageUrl: 'legacy-secret-url' }])
  for (const identifier of [id, owner]) {
    const result = await request(app).get('/api/users/' + identifier).set(headers()).expect(200)
    assert.equal(result.body.data.id, id)
    assert.equal(result.body.data.kycObjectKey, undefined)
    assert.equal(result.body.data.idImageUrl, undefined)
  }
})
test('ambiguous IDs return conflict and explicit Auth lookup remains available', async () => {
  stub(prisma.user, 'findMany', async (query: any) => query.where.authUserId ? [profile] : [profile, { ...profile, id: other }])
  await request(app).get('/api/users/' + owner).set(headers()).expect(409)
  await request(app).get('/api/users/by-auth/' + owner).set(headers()).expect(200)
})
test('another user cannot read, update or submit KYC even with forged owner header', async () => {
  stub(prisma.user, 'findMany', async () => [profile])
  const forged = { ...headers(other), 'x-user-id': owner }
  await request(app).get('/api/users/' + id).set(forged).expect(403)
  await request(app).put('/api/users/' + id).set(forged).send({ fullName: 'Attacker' }).expect(403)
  await request(app).post('/api/users/' + id + '/kyc').set(forged).field('idNumber', '123').attach('document', Buffer.from('bad'), 'a.png').expect(403)
})
test('deleted profile is not accessible', async () => {
  stub(prisma.user, 'findMany', async () => [{ ...profile, deletedAt: new Date() }])
  await request(app).get('/api/users/' + id).set(headers()).expect(404)
})
test('profile creation requires internal credentials', async () => {
  await request(app).post('/api/users').set(headers()).send({ authUserId: owner, email: 'a@example.com' }).expect(401)
})
test('KYC image validation decodes real content and rejects disguised/truncated files', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer()
  const result = await normalizeImage({ buffer: png, mimetype: 'image/png' })
  assert.equal((await sharp(result).metadata()).format, 'jpeg')
  for (const file of [
    { buffer: Buffer.from('<script>alert(1)</script>'), mimetype: 'image/png' },
    { buffer: png.subarray(0, 20), mimetype: 'image/png' },
    { buffer: png, mimetype: 'image/jpeg' },
    { buffer: png, mimetype: 'application/pdf' }
  ]) await assert.rejects(normalizeImage(file), (error: any) => error.code === 'INVALID_IMAGE')
  await assert.rejects(normalizeImage({ buffer: Buffer.alloc(5 * 1024 * 1024 + 1), mimetype: 'image/png' }), (error: any) => error.status === 413)
})
