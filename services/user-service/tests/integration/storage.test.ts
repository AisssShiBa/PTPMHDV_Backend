import '../setup'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import sharp from 'sharp'
import { S3Client, CreateBucketCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import app from '../../src/app'
import { prisma } from '../../src/config/prisma'
import { env } from '../../src/config/env'
import { submitDocument, cleanupStorage } from '../../src/services/kyc.service'
const s3 = new S3Client({ endpoint: env.s3.endpoint, region: env.s3.region, forcePathStyle: true,
  credentials: { accessKeyId: env.s3.accessKeyId!, secretAccessKey: env.s3.secretAccessKey! } })
const bucket = env.s3.bucket!
const auth = (userId: string, role = 'USER') => ({ 'x-gateway-verified': 'true', authorization: 'Bearer ' + jwt.sign({ userId, role }, env.accessTokenSecret) })
before(async () => {
  assert.equal(bucket, 'finvault-kyc-test')
  assert.ok(process.env.DATABASE_URL?.includes('/finvault_test?schema=user_test'))
  await prisma.storageCleanup.deleteMany()
  await prisma.consumedEvent.deleteMany()
  await prisma.user.deleteMany()
  try { await s3.send(new HeadBucketCommand({ Bucket: bucket })) }
  catch { await s3.send(new CreateBucketCommand({ Bucket: bucket })) }
})
after(async () => {
  const objects = await s3.send(new ListObjectsV2Command({ Bucket: bucket }))
  if (objects.Contents?.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects.Contents.map(o => ({ Key: o.Key! })) } }))
  s3.destroy()
  await prisma.$disconnect()
})
test('real multipart KYC upload remains private, reads via authorized URL, and transitions are enforced', async () => {
  const user = await prisma.user.create({ data: { authUserId: randomUUID(), email: 's3@example.com' } })
  const png = await sharp({ create: { width: 5, height: 5, channels: 3, background: '#fff' } }).png().toBuffer()
  const result = await request(app).post('/api/users/' + user.authUserId + '/kyc').set(auth(user.authUserId))
    .field('idNumber', '123456').attach('document', png, { filename: '../untrusted.png', contentType: 'image/png' }).expect(200)
  assert.equal(result.body.data.kycStatus, 'PENDING')
  assert.equal(result.body.data.kycObjectKey, undefined)
  const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
  assert.ok(updated.kycObjectKey?.startsWith('kyc/' + user.id + '/'))
  assert.equal(updated.kycMimeType, 'image/jpeg')
  await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: updated.kycObjectKey! }))
  const anonymous = await fetch(env.s3.endpoint + '/' + bucket + '/' + updated.kycObjectKey)
  assert.equal(anonymous.status, 403)
  await request(app).get('/api/users/' + user.id + '/kyc/document').set(auth(randomUUID())).expect(403)
  const access = await request(app).get('/api/users/' + user.id + '/kyc/document').set(auth(user.authUserId)).expect(200)
  assert.equal(access.body.data.expiresIn, 60)
  assert.equal((await fetch(access.body.data.url)).status, 200)
  const admin = auth(randomUUID(), 'ADMIN')
  await request(app).patch('/api/users/' + user.id + '/kyc-status').set(auth(user.authUserId)).send({ kycStatus: 'APPROVED' }).expect(403)
  await request(app).patch('/api/users/' + user.id + '/kyc-status').set(admin).send({ kycStatus: 'APPROVED' }).expect(200)
  await request(app).patch('/api/users/' + user.id + '/kyc-status').set(admin).send({ kycStatus: 'APPROVED' }).expect(200)
  await request(app).patch('/api/users/' + user.id + '/kyc-status').set(admin).send({ kycStatus: 'NONE' }).expect(409)
  await request(app).post('/api/users/' + user.id + '/kyc').set(auth(user.authUserId)).field('idNumber', '123456')
    .attach('document', png, { filename: 'a.png', contentType: 'image/png' }).expect(409)
  await request(app).patch('/api/users/' + user.id + '/kyc-status').set(admin).send({ kycStatus: 'REJECTED' }).expect(200)
  await request(app).post('/api/users/by-auth/' + user.authUserId + '/kyc').set(auth(user.authUserId)).field('idNumber', '123456')
    .attach('document', png, { filename: 'a.png', contentType: 'image/png' }).expect(200)
  await cleanupStorage()
  await assert.rejects(s3.send(new HeadObjectCommand({ Bucket: bucket, Key: updated.kycObjectKey! })))
})
test('DB concurrency conflict after upload is eventually cleaned without replacing the current document', async () => {
  const user = await prisma.user.create({ data: { authUserId: randomUUID(), email: 'race-s3@example.com' } })
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer()
  await prisma.user.update({ where: { id: user.id }, data: { version: { increment: 1 } } })
  await assert.rejects(submitDocument(user, '123', { buffer: png, mimetype: 'image/png' }), (e: any) => e.code === 'CONCURRENT_UPDATE')
  const job = await prisma.storageCleanup.findFirstOrThrow()
  await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: job.objectKey }))
  await prisma.storageCleanup.update({ where: { objectKey: job.objectKey }, data: { nextAttemptAt: new Date(0) } })
  await cleanupStorage()
  await assert.rejects(s3.send(new HeadObjectCommand({ Bucket: bucket, Key: job.objectKey })))
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).kycObjectKey, null)
})
test('HTTP upload rejects malformed, missing and oversized documents', async () => {
  const user = await prisma.user.create({ data: { authUserId: randomUUID(), email: 'bad-upload@example.com' } })
  const path = '/api/users/' + user.id + '/kyc'
  await request(app).post(path).set(auth(user.authUserId)).send({ idNumber: '123' }).expect(400)
  await request(app).post(path).set(auth(user.authUserId)).field('idNumber', '123').attach('document', Buffer.from('not image'), 'bad.png').expect(400)
  await request(app).post(path).set(auth(user.authUserId)).field('idNumber', '123').attach('document', Buffer.alloc(5 * 1024 * 1024 + 1), 'large.png').expect(413)
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).kycStatus, 'NONE')
})
