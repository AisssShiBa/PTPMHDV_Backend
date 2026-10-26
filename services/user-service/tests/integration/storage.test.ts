import { createTestGatewayToken } from 'finvault-internal-auth'
import '../setup'
import { stub } from '../stub'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import sharp from 'sharp'
import { S3Client, CreateBucketCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import app from '../../src/app'
import { prisma } from '../../src/config/prisma'
import { env } from '../../src/config/env'
import { submitDocuments, cleanupStorage } from '../../src/services/kyc.service'
import { setTimeout as delay } from 'node:timers/promises'
import { scanKycOrphans, lockKycObject, removeUnreferenced } from '../../src/services/storage-cleanup'
import { storage } from '../../src/services/storage'
const s3 = new S3Client({ endpoint: env.s3.endpoint, region: env.s3.region, forcePathStyle: true,
  credentials: { accessKeyId: env.s3.accessKeyId!, secretAccessKey: env.s3.secretAccessKey! } })
const bucket = env.s3.bucket!
const auth = (userId: string, role = 'USER') => ({ 'x-gateway-token': createTestGatewayToken(userId, role) })
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
    .field('idNumber', '123456').attach('front', png, { filename: '../untrusted.png', contentType: 'image/png' }).attach('back', png, { filename: '../untrusted.png', contentType: 'image/png' }).expect(202)
  assert.equal(result.body.data.kycStatus, 'PENDING')
  assert.equal(result.body.data.kycObjectKey, undefined)
  assert.equal(result.body.data.kycBackObjectKey, undefined)
  const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
  assert.ok(updated.kycObjectKey?.startsWith('kyc/' + user.id + '/'))
  assert.ok(updated.kycBackObjectKey?.startsWith('kyc/' + user.id + '/'))
  assert.notEqual(updated.kycObjectKey, updated.kycBackObjectKey)
  assert.equal(updated.kycMimeType, 'image/jpeg')
  await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: updated.kycObjectKey! }))
  const anonymous = await fetch(env.s3.endpoint + '/' + bucket + '/' + updated.kycObjectKey)
  assert.equal(anonymous.status, 403)
  await request(app).get('/api/users/' + user.id + '/kyc/document').set(auth(randomUUID())).expect(403)
  const access = await request(app).get('/api/users/' + user.id + '/kyc/document').set(auth(user.authUserId)).expect(200)
  assert.equal(access.body.data.expiresIn, 300)
  assert.equal((await fetch(access.body.data.url)).status, 200)
  const admin = auth(randomUUID(), 'ADMIN')
  await request(app).patch('/api/users/' + user.id + '/kyc-status').set(auth(user.authUserId)).send({ kycStatus: 'APPROVED' }).expect(403)
  await request(app).patch('/api/users/' + user.id + '/kyc-status').set(admin).send({ kycStatus: 'APPROVED' }).expect(200)
  await request(app).patch('/api/users/' + user.id + '/kyc-status').set(admin).send({ kycStatus: 'APPROVED' }).expect(200)
  await request(app).patch('/api/users/' + user.id + '/kyc-status').set(admin).send({ kycStatus: 'NONE' }).expect(409)
  await request(app).post('/api/users/' + user.id + '/kyc').set(auth(user.authUserId)).field('idNumber', '123456')
    .attach('front', png, { filename: 'a.png', contentType: 'image/png' }).attach('back', png, { filename: 'a.png', contentType: 'image/png' }).expect(409)
  await request(app).patch('/api/users/' + user.id + '/kyc-status').set(admin).send({ kycStatus: 'REJECTED' }).expect(200)
  await request(app).post('/api/users/by-auth/' + user.authUserId + '/kyc').set(auth(user.authUserId)).field('idNumber', '123456')
    .attach('front', png, { filename: 'a.png', contentType: 'image/png' }).attach('back', png, { filename: 'a.png', contentType: 'image/png' }).expect(202)
  await cleanupStorage()
  await assert.rejects(s3.send(new HeadObjectCommand({ Bucket: bucket, Key: updated.kycObjectKey! })))
  await assert.rejects(s3.send(new HeadObjectCommand({ Bucket: bucket, Key: updated.kycBackObjectKey! })))
})
test('DB concurrency conflict after upload is eventually cleaned without replacing the current document', async () => {
  const user = await prisma.user.create({ data: { authUserId: randomUUID(), email: 'race-s3@example.com' } })
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer()
  await prisma.user.update({ where: { id: user.id }, data: { version: { increment: 1 } } })
  await assert.rejects(submitDocuments(user, '123', { buffer: png, mimetype: 'image/png' }, { buffer: png, mimetype: 'image/png' }), (e: any) => e.code === 'CONCURRENT_UPDATE')
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

test('current-user multipart route submits the signed users document and exposes status DTO', async () => {
  const user = await prisma.user.create({ data: { authUserId: randomUUID(), email: 'me-upload@example.com' } })
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer()
  await request(app).post('/api/users/me/kyc').set(auth(user.authUserId)).field('idNumber', '123')
    .attach('front', png, { filename: 'id.png', contentType: 'image/png' }).attach('back', png, { filename: 'id.png', contentType: 'image/png' }).expect(202)
  const result = await request(app).get('/api/users/me/kyc').set(auth(user.authUserId)).expect(200)
  assert.deepEqual(result.body.data, { kycStatus: 'PENDING', kycTier: 0, hasKycDocument: true })
})

test('H8 requires both faces on every submission route and refuses approval of legacy one-face profiles', async () => {
  const user = await prisma.user.create({ data: { authUserId: randomUUID(), email: randomUUID() + '@example.test' } })
  const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#eee' } }).png().toBuffer()
  for (const path of ['/api/users/kyc/documents', '/api/users/me/kyc', '/api/users/' + user.id + '/kyc',
    '/api/users/by-auth/' + user.authUserId + '/kyc']) {
    for (const side of ['front', 'back', 'document']) {
      const result = await request(app).post(path).set(auth(user.authUserId)).field('idNumber', '000000001234')
        .attach(side, png, { filename: 'synthetic.png', contentType: 'image/png' }).expect(400)
      assert.equal(result.body.error.code, 'KYC_DOCUMENTS_REQUIRED')
    }
  }
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).kycStatus, 'NONE')
  await prisma.user.update({ where: { id: user.id }, data: {
    kycStatus: 'PENDING', kycObjectKey: 'kyc/legacy.jpg', idNumber: '000000001234'
  } })
  const rejected = await request(app).patch(`/api/users/${user.id}/kyc-status`).set(auth(randomUUID(), 'ADMIN'))
    .send({ kycStatus: 'APPROVED' }).expect(409)
  assert.equal(rejected.body.error.code, 'KYC_DOCUMENTS_REQUIRED')
})

test('H8 validates both images before writing, rejects extra fields and oversized back image, and returns 202', async () => {
  const user = await prisma.user.create({ data: { authUserId: randomUUID(), email: randomUUID() + '@example.test' } })
  const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#eee' } }).png().toBuffer()
  const upload = () => request(app).post('/api/users/kyc/documents').set(auth(user.authUserId))
    .field('idNumber', '000000001234').attach('front', png, { filename: 'front.png', contentType: 'image/png' })
  const beforeJobs = await prisma.storageCleanup.count()
  await upload().attach('back', Buffer.from('not an image'), 'fake.png').expect(400)
  await upload().attach('back', Buffer.alloc(5 * 1024 * 1024 + 1), 'big.png').expect(413)
  await upload().field('kycTier', '2').attach('back', png, 'back.png').expect(400)
  assert.equal(await prisma.storageCleanup.count(), beforeJobs)
  const response = await upload().attach('back', png, 'back.png').expect(202)
  assert.equal(response.body.data.kycStatus, 'PENDING')
  assert.equal(response.body.data.kycTier, 0)
  const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
  for (const key of [row.kycObjectKey!, row.kycBackObjectKey!])
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
})

test('H8 failure on back upload preserves both old references and leaves both cleanup intents durable', async () => {
  const user = await prisma.user.create({ data: { authUserId: randomUUID(), email: randomUUID() + '@example.test' } })
  const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#eee' } }).png().toBuffer()
  const file = { buffer: png, mimetype: 'image/png' }
  const original = await submitDocuments(user, '000000001234', file, file)
  const put = storage.put.bind(storage)
  const attempted: string[] = []
  stub(storage, 'put', async (key: string, body: Buffer) => {
    attempted.push(key)
    if (attempted.length === 2) throw new Error('Back image storage failure')
    await put(key, body)
  })
  await assert.rejects(submitDocuments(original, '000000005678', file, file), (e: any) => e.code === 'KYC_SUBMISSION_FAILED')
  const current = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
  assert.equal(current.kycObjectKey, original.kycObjectKey)
  assert.equal(current.kycBackObjectKey, original.kycBackObjectKey)
  assert.equal(current.version, original.version)
  assert.equal(current.idNumber, original.idNumber)
  assert.equal(await prisma.storageCleanup.count({ where: { objectKey: { in: attempted } } }), 2)
  await prisma.storageCleanup.updateMany({ where: { objectKey: { in: attempted } }, data: { nextAttemptAt: new Date(0) } })
  await cleanupStorage()
  await assert.rejects(s3.send(new HeadObjectCommand({ Bucket: bucket, Key: attempted[0] })))
  for (const key of [original.kycObjectKey!, original.kycBackObjectKey!])
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
})

test('S12 USER cannot obtain another users two URLs and both signed URLs expire on MinIO with TTL 2 seconds', async () => {
  const user = await prisma.user.create({ data: { authUserId: randomUUID(), email: randomUUID() + '@example.test' } })
  const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#eee' } }).png().toBuffer()
  await submitDocuments(user, '000000001234', { buffer: png, mimetype: 'image/png' }, { buffer: png, mimetype: 'image/png' })
  const path = `/api/users/${user.id}/kyc/documents`
  await request(app).get(path).set(auth(randomUUID())).expect(403)
  const admin = auth(randomUUID(), 'ADMIN')
  await request(app).get(path).set(admin).expect(403)
  await request(app).get(`/api/users/${user.id}/kyc/document`).set(admin).expect(403)
  await request(app).get(`/api/users/by-auth/${user.authUserId}/kyc/document`).set(admin).expect(403)
  stub(env, 'kycUrlTtlSeconds', 2 as any)
  const response = await request(app).get(path).set('x-internal-key', process.env.INTERNAL_KEY!).expect(200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.ok(Date.parse(response.body.data.expiresAt) <= Date.now() + 2000)
  for (const url of [response.body.data.frontUrl, response.body.data.backUrl]) {
    assert.equal(new URL(url).searchParams.get('X-Amz-Expires'), '2')
    assert.equal((await fetch(url)).status, 200)
    const unsigned = new URL(url); unsigned.search = ''
    assert.equal((await fetch(unsigned)).status, 403)
  }
  await delay(3100)
  for (const url of [response.body.data.frontUrl, response.body.data.backUrl])
    assert.equal((await fetch(url)).status, 403)
})

test('real scanner finds untracked objects, protects jobs/references and leaves dry-run unchanged', async () => {
  const prefix = 'kyc/scan-' + randomUUID() + '/'
  const keys = ['active', 'tracked', 'untracked', 'inflight'].map(name => prefix + name)
  for (const key of keys) await storage.put(key, Buffer.from('test object'))
  await prisma.user.create({ data: { authUserId: randomUUID(), email: randomUUID() + '@example.com', kycObjectKey: keys[0] } })
  await prisma.storageCleanup.create({ data: { objectKey: keys[1], nextAttemptAt: new Date(0) } })
  await prisma.storageCleanup.create({ data: { objectKey: keys[3], nextAttemptAt: new Date(Date.now() + 60000) } })
  // Use the timestamps returned by LIST (HEAD can round to whole seconds).
  // Docker and host clocks may differ slightly; a fixed 20ms sleep is flaky.
  const timestamps: number[] = []
  for await (const object of storage.listKyc()) {
    if (keys.includes(object.key)) timestamps.push(object.lastModified!.getTime())
  }
  assert.equal(timestamps.length, keys.length)
  const waitMs = Math.max(0, Math.max(...timestamps) + 2 - Date.now()) + 50
  assert.ok(waitMs < 10000, 'Storage/host clocks differ by more than the test allowance')
  await delay(waitMs)
  const beforeJobs = await prisma.storageCleanup.findMany({ orderBy: { objectKey: 'asc' } })
  const candidates: any[] = []
  const dry = await scanKycOrphans({ graceMs: 1, log: entry => candidates.push(entry) })
  assert.equal(dry.deleted, 0)
  assert.deepEqual(await prisma.storageCleanup.findMany({ orderBy: { objectKey: 'asc' } }), beforeJobs)
  assert.ok(candidates.some(entry => entry.objectKey === keys[2]))
  for (const key of keys) await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  const real = await scanKycOrphans({ dryRun: false, graceMs: 1, log: () => {} })
  assert.equal(real.failed, 0)
  for (const key of [keys[1], keys[2]]) await assert.rejects(s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })))
  for (const key of [keys[0], keys[3]]) await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
})

test('cleanup waits for a concurrent submission commit and keeps the newly referenced object', async () => {
  const key = 'kyc/race-' + randomUUID()
  await storage.put(key, Buffer.from('test object'))
  await prisma.storageCleanup.create({ data: { objectKey: key, nextAttemptAt: new Date(0) } })
  let locked!: () => void
  const hasLock = new Promise<void>(resolve => { locked = resolve })
  let release!: () => void
  const continueCommit = new Promise<void>(resolve => { release = resolve })
  const submission = prisma.$transaction(async tx => {
    await lockKycObject(tx, key)
    locked()
    await continueCommit
    await tx.user.create({ data: { authUserId: randomUUID(), email: randomUUID() + '@example.com', kycObjectKey: key } })
    await tx.storageCleanup.delete({ where: { objectKey: key } })
  })
  await hasLock
  const deletion = removeUnreferenced(key)
  release()
  await submission
  assert.equal(await deletion, 'referenced')
  await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
})

test('an expired upload removed by cleanup cannot later commit a dangling reference', async () => {
  const user = await prisma.user.create({ data: { authUserId: randomUUID(), email: randomUUID() + '@example.com' } })
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer()
  const put = storage.put.bind(storage)
  let uploadedKey = ''
  stub(storage, 'put', async (key: string, data: Buffer) => {
    uploadedKey = key
    await put(key, data)
    await prisma.storageCleanup.update({ where: { objectKey: key }, data: { nextAttemptAt: new Date(0) } })
    assert.equal(await removeUnreferenced(key, true), 'deleted')
  })
  await assert.rejects(submitDocuments(user, '123', { buffer: png, mimetype: 'image/png' }, { buffer: png, mimetype: 'image/png' }))
  const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
  assert.equal(unchanged.kycObjectKey, null)
  assert.equal(unchanged.kycStatus, 'NONE')
  await assert.rejects(s3.send(new HeadObjectCommand({ Bucket: bucket, Key: uploadedKey })))
})

test('listing reads all continuation pages', async () => {
  const commands: any[] = []
  stub(S3Client.prototype, 'send', async (command: any) => {
    commands.push(command.input)
    return commands.length === 1
      ? { Contents: [{ Key: 'kyc/first', LastModified: new Date() }], IsTruncated: true, NextContinuationToken: 'page-2' }
      : { Contents: [{ Key: 'kyc/second', LastModified: new Date() }], IsTruncated: false }
  })
  const keys: string[] = []
  for await (const object of storage.listKyc()) keys.push(object.key)
  assert.deepEqual(keys, ['kyc/first', 'kyc/second'])
  assert.equal(commands[0].Prefix, 'kyc/')
  assert.equal(commands[1].ContinuationToken, 'page-2')
})

test('a successful storage delete followed by DB rollback cannot leave a late-upload reference', async () => {
  const user = await prisma.user.create({ data: { authUserId: randomUUID(), email: randomUUID() + '@example.com' } })
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer()
  const put = storage.put.bind(storage)
  const original = prisma.$transaction.bind(prisma)
  let failCleanup = true
  stub(prisma, '$transaction', (callback: any, options: any) => original(async tx => {
    if (failCleanup) tx.storageCleanup.deleteMany = (async () => { throw new Error('DB write failed after S3 delete') }) as any
    return callback(tx)
  }, options))
  stub(storage, 'put', async (key: string, data: Buffer) => {
    await put(key, data)
    await prisma.storageCleanup.update({ where: { objectKey: key }, data: { nextAttemptAt: new Date(0) } })
    await assert.rejects(removeUnreferenced(key, true))
    assert.ok(await prisma.storageCleanup.findUnique({ where: { objectKey: key } }))
    failCleanup = false
  })
  await assert.rejects(submitDocuments(user, '123', { buffer: png, mimetype: 'image/png' }, { buffer: png, mimetype: 'image/png' }))
  const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
  assert.equal(unchanged.kycObjectKey, null)
  assert.equal(unchanged.kycStatus, 'NONE')
})
