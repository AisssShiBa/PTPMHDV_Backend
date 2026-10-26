import '../setup'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { createTestGatewayToken } from 'finvault-internal-auth'
import app from '../../src/app'
import { prisma } from '../../src/config/prisma'
import { maskName } from '../../src/services/recipient-lookup'

before(() => assert.ok(process.env.DATABASE_URL?.includes('/finvault_test?schema=user_test')))
after(() => prisma.$disconnect())
const create = (data = {}) => prisma.user.create({ data: {
  authUserId: randomUUID(), email: randomUUID() + '@example.test', ...data
} })
const headers = (id: string) => ({ 'x-gateway-token': createTestGatewayToken(id) })
const lookup = (id: string, q: string) => request(app).get('/api/users/lookup').set(headers(id)).query({ q })

test('H11 exact email/phone matches return only masked identity; wildcards and partial input do not match', async () => {
  const caller = await create()
  const recipient = await create({ fullName: 'Nguyễn Văn Bình', phone: '091' + randomUUID() })
  for (const q of [recipient.email.toUpperCase(), recipient.phone!]) {
    const result = await lookup(caller.authUserId, q).expect(200)
    assert.deepEqual(result.body.data, { authUserId: recipient.authUserId, maskedName: 'Nguyễn V. B.' })
    assert.equal(result.headers['cache-control'], 'no-store')
  }
  for (const q of [recipient.email.slice(0, 8), '%@example.test', '_@example.test', recipient.phone!.slice(0, 5)])
    await lookup(caller.authUserId, q).expect(404)
  assert.equal(maskName(null), '***')
  assert.equal(maskName('  Bình '), 'B***')
})

test('S13 missing, self, deleted and ambiguous recipients share the same 404 error', async () => {
  const caller = await create()
  const deleted = await create({ deletedAt: new Date() })
  const phone = 'duplicate-' + randomUUID()
  await create({ phone }); await create({ phone })
  const results = []
  for (const q of ['missing-' + randomUUID(), caller.email, deleted.email, phone])
    results.push((await lookup(caller.authUserId, q).expect(404)).body.error)
  assert.ok(results.every(value => JSON.stringify(value) === JSON.stringify(results[0])))
  assert.deepEqual(results[0], { code: 'RECIPIENT_NOT_FOUND', message: 'Recipient not found' })
})

test('S13 the eleventh attempt is 429, failures count, identities cannot be spoofed, and another caller has its own budget', async () => {
  const caller = await create(), other = await create()
  for (let i = 0; i < 10; i++) await lookup(caller.authUserId, 'missing').expect(404)
  await prisma.$disconnect() // Restarting the connection does not reset the database budget.
  const limited = await lookup(caller.authUserId, other.email)
    .set('x-user-id', other.authUserId).set('x-forwarded-for', '192.0.2.1').expect(429)
  assert.equal(limited.body.error.code, 'RATE_LIMIT_EXCEEDED')
  assert.equal(limited.headers['retry-after'], '60')
  await lookup(other.authUserId, caller.email).expect(200)
  await prisma.$executeRaw`UPDATE recipient_lookup_limits SET attempts = ARRAY[statement_timestamp() - INTERVAL '61 seconds']
    WHERE auth_user_id = ${caller.authUserId}`
  await lookup(caller.authUserId, other.email).expect(200)
})

test('S13 concurrent requests share exactly ten rolling-minute slots; recent slots survive expiry of older attempts', async () => {
  const caller = await create(), recipient = await create()
  const results = await Promise.all(Array.from({ length: 20 }, () => lookup(caller.authUserId, recipient.email)))
  assert.equal(results.filter(r => r.status === 200).length, 10)
  assert.equal(results.filter(r => r.status === 429).length, 10)
  await prisma.$executeRaw`UPDATE recipient_lookup_limits SET attempts =
    ARRAY[statement_timestamp() - INTERVAL '61 seconds'] || array_fill(statement_timestamp(), ARRAY[9])
    WHERE auth_user_id = ${caller.authUserId}`
  await lookup(caller.authUserId, recipient.email).expect(200)
  await lookup(caller.authUserId, recipient.email).expect(429)
})

test('lookup requires signed USER identity and counts malformed queries without echoing them', async () => {
  await request(app).get('/api/users/lookup?q=test').expect(401)
  await request(app).get('/api/users/lookup?q=test').set('x-internal-key', process.env.INTERNAL_KEY!).expect(403)
  await request(app).get('/api/users/lookup?q=test').set('x-gateway-token', createTestGatewayToken(randomUUID(), 'ADMIN')).expect(403)
  const caller = await create()
  await request(app).get('/api/users/lookup').set(headers(caller.authUserId)).expect(400)
  await request(app).get('/api/users/lookup?q=a&q=b').set(headers(caller.authUserId)).expect(400)
})
