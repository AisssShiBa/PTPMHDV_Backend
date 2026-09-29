import '../setup'
import { test, before, beforeEach, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { prisma } from '../../src/config/prisma'
import app from '../../src/app'
import { consumeRegistration } from '../../src/events/registration'
import { submitDocument, cleanupStorage } from '../../src/services/kyc.service'
import { storage } from '../../src/services/storage'
import sharp from 'sharp'

const internal = { 'x-internal-key': process.env.INTERNAL_KEY! }
const auth = (userId: string, role = 'USER') => ({ 'x-gateway-verified': 'true', authorization: 'Bearer ' + jwt.sign({ userId, role }, process.env.ACCESS_TOKEN_SECRET!) })
before(async () => {
  assert.ok(process.env.DATABASE_URL?.includes('/finvault_test?schema=user_test'))
  await prisma.$connect()
})
beforeEach(async () => {
  await prisma.consumedEvent.deleteMany()
  await prisma.storageCleanup.deleteMany()
  await prisma.user.deleteMany()
})
after(async () => { mock.restoreAll(); await prisma.$disconnect() })
test('concurrent internal create produces one profile and deterministic conflicts', async () => {
  const authUserId = randomUUID()
  const results = await Promise.all(Array.from({ length: 5 }, () => request(app).post('/api/users').set(internal).send({ authUserId, email: 'concurrent@example.com' })))
  assert.equal(results.filter(r => r.status === 201).length, 1)
  assert.ok(results.every(r => [201, 409].includes(r.status)))
  assert.equal(await prisma.user.count(), 1)
})
test('consumer replay and concurrent delivery create one profile and one inbox record', async () => {
  const event = { eventId: randomUUID(), eventType: 'user.registered', eventVersion: 1, occurredAt: new Date().toISOString(), data: { authUserId: randomUUID(), email: 'event@example.com' } }
  await Promise.all(Array.from({ length: 5 }, () => consumeRegistration(event)))
  await prisma.$disconnect() // Persistence survives a client restart.
  await consumeRegistration(event)
  assert.equal(await prisma.user.count(), 1)
  assert.equal(await prisma.consumedEvent.count(), 1)
  await assert.rejects(consumeRegistration({ ...event, data: { ...event.data, email: 'changed@example.com' } }), (e: any) => e.code === 'EVENT_CONFLICT')
  await consumeRegistration({ ...event, eventId: randomUUID() })
  assert.equal(await prisma.user.count(), 1)
})
test('consumer conflicts roll back inbox and never revive deleted users', async () => {
  const existing = await prisma.user.create({ data: { authUserId: randomUUID(), email: 'taken@example.com', deletedAt: new Date() } })
  const base = { eventId: randomUUID(), eventType: 'user.registered', eventVersion: 1, occurredAt: new Date().toISOString() }
  for (const authUserId of [existing.authUserId, randomUUID()]) {
    await assert.rejects(consumeRegistration({ ...base, data: { authUserId, email: existing.email } }))
  }
  assert.equal(await prisma.consumedEvent.count(), 0)
  assert.equal(await prisma.user.count(), 1)
})
test('owner update uses Auth ID, list validates query, soft-deleted profiles disappear', async () => {
  const user = await prisma.user.create({ data: { authUserId: randomUUID(), email: 'owner@example.com' } })
  await request(app).put('/api/users/' + user.authUserId).set(auth(user.authUserId)).send({ fullName: '  Huu  ' }).expect(200)
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).fullName, 'Huu')
  await request(app).put('/api/users/by-auth/' + user.authUserId).set(auth(user.authUserId)).send({ address: 'Address' }).expect(200)
  await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } })
  await request(app).get('/api/users/' + user.id).set(auth(user.authUserId)).expect(404)
  const result = await request(app).get('/api/users').set(internal).expect(200)
  assert.equal(result.body.data.totalElements, 0)
})
test('ambiguous identifier cannot update either account', async () => {
  const shared = randomUUID()
  const user = await prisma.user.create({ data: { id: shared, authUserId: randomUUID(), email: 'a@example.com' } })
  await prisma.user.create({ data: { authUserId: shared, email: 'b@example.com' } })
  await request(app).put('/api/users/' + shared).set(auth(user.authUserId)).send({ fullName: 'Changed' }).expect(409)
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: shared } })).fullName, null)
})
test('failed storage writes leave durable cleanup jobs and no KYC state change', async () => {
  const user = await prisma.user.create({ data: { authUserId: randomUUID(), email: 'upload-fail@example.com' } })
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer()
  const fail = mock.method(storage, 'put', async () => { throw new Error('Storage down') })
  await assert.rejects(submitDocument(user, '123', { buffer: image, mimetype: 'image/png' }))
  fail.mock.restore()
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).kycStatus, 'NONE')
  assert.equal(await prisma.storageCleanup.count(), 1)
})
test('cleanup protects an object referenced by a committed KYC submission', async () => {
  await prisma.user.create({ data: { authUserId: randomUUID(), email: 'reference@example.com', kycObjectKey: 'referenced.jpg' } })
  await prisma.storageCleanup.create({ data: { objectKey: 'referenced.jpg' } })
  const remove = mock.method(storage, 'remove', async () => { throw new Error('Must not delete a live document') })
  await cleanupStorage()
  assert.equal(remove.mock.callCount(), 0)
  assert.equal(await prisma.storageCleanup.count(), 0)
  remove.mock.restore()
})
