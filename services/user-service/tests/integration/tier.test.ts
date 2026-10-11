import '../setup'
import { stub } from '../stub'
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../../src/config/prisma'
import { updateKycTier } from '../../src/services/kyc-tier.service'
import { setKycStatus } from '../../src/services/user.service'

before(async () => {
  assert.ok(process.env.DATABASE_URL?.includes('/finvault_test?schema=user_test'))
  await prisma.$connect()
})
beforeEach(async () => { await prisma.userOutboxEvent.deleteMany(); await prisma.user.deleteMany() })
after(() => prisma.$disconnect())
const create = () => prisma.user.create({ data: { authUserId: randomUUID(), email: randomUUID() + '@example.com' } })

test('tier changes record explicit Auth identity and a single event; repeated tier is a no-op', async () => {
  const user = await create()
  assert.equal(user.kycTier, 0)
  const updated = await updateKycTier(user.id, 1)
  assert.equal(updated.kycStatus, 'NONE')
  assert.equal(updated.version, 1)
  await updateKycTier(user.id, 1)
  const events = await prisma.userOutboxEvent.findMany()
  assert.equal(events.length, 1)
  assert.equal(events[0].status, 'PENDING')
  assert.equal(events[0].aggregateId, user.id)
  assert.equal(events[0].aggregateVersion, 1)
  const payload = events[0].payload as any
  assert.equal(payload.eventId, events[0].id)
  assert.equal(payload.eventType, 'user.kyc_updated')
  assert.equal(payload.eventVersion, 1)
  assert.deepEqual(payload.data, { authUserId: user.authUserId, kycTier: 1 })
})

test('outbox failure rolls back tier and version in the real database', async () => {
  const user = await create()
  const original = prisma.$transaction.bind(prisma)
  stub(prisma, '$transaction', (callback: any, options: any) => original(async tx => {
    tx.userOutboxEvent.create = (async () => { throw new Error('Injected outbox failure') }) as any
    return callback(tx)
  }, options))
  await assert.rejects(updateKycTier(user.id, 2))
  const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
  assert.equal(unchanged.kycTier, 0)
  assert.equal(unchanged.version, 0)
  assert.equal(await prisma.userOutboxEvent.count(), 0)
})

test('concurrent requests for the same tier produce one transition and one event', async () => {
  const user = await create()
  await Promise.all(Array.from({ length: 5 }, () => updateKycTier(user.id, 2)))
  assert.equal(await prisma.userOutboxEvent.count(), 1)
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).version, 1)
})

test('tier validation and tombstones do not produce events; approval remains independent', async () => {
  const user = await create()
  for (const tier of [-1, 3, 1.5, NaN, '1']) await assert.rejects(updateKycTier(user.id, tier as number))
  const pending = await prisma.user.update({ where: { id: user.id }, data: { kycStatus: 'PENDING', kycObjectKey: 'kyc/test.jpg', idNumber: '123' } })
  const approved = await setKycStatus(pending, 'APPROVED')
  assert.equal(approved.kycTier, 0)
  assert.equal(await prisma.userOutboxEvent.count(), 0)
  await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } })
  await assert.rejects(updateKycTier(user.id, 1), (e: any) => e.status === 404)
  await assert.rejects(updateKycTier(randomUUID(), 1), (e: any) => e.status === 404)
})

test('migration preserves existing approved profiles and defaults old and new rows to tier zero', async () => {
  const schema = 'migration_test_' + randomUUID().replaceAll('-', '')
  const rollback = new Error('Rollback isolated migration fixture')
  const sql = readFileSync('prisma/migrations/202610070001_kyc_tier_outbox/migration.sql', 'utf8')
  await assert.rejects(prisma.$transaction(async tx => {
    // Generated identifier contains only fixed prefix and UUID hex, never user input.
    await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`)
    await tx.$executeRawUnsafe('CREATE TABLE users (id TEXT PRIMARY KEY, kyc_status TEXT NOT NULL)')
    await tx.$executeRaw`INSERT INTO users (id, kyc_status) VALUES ('old-approved', 'APPROVED'), ('old-none', 'NONE')`
    for (const statement of sql.split(';').filter(part => part.trim())) await tx.$executeRawUnsafe(statement)
    await tx.$executeRaw`INSERT INTO users (id, kyc_status) VALUES ('new', 'NONE')`
    const rows = await tx.$queryRaw<{ id: string; kyc_status: string; kyc_tier: number }[]>`SELECT * FROM users ORDER BY id`
    assert.equal(rows.length, 3)
    assert.ok(rows.every(row => row.kyc_tier === 0))
    assert.equal(rows.find(row => row.id === 'old-approved')?.kyc_status, 'APPROVED')
    const events = await tx.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) FROM user_outbox_events`
    assert.equal(Number(events[0].count), 0)
    throw rollback // Transaction rollback also removes the temporary schema/tables.
  }), error => error === rollback)
})
