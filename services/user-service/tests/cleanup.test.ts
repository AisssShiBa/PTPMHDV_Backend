import './setup'
import { stub } from './stub'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../src/config/prisma'
import { storage } from '../src/services/storage'
import { scanKycOrphans } from '../src/services/storage-cleanup'
const old = new Date(Date.now() - 100000)
const quiet = () => {}

test('dry-run finds tracked/untracked orphans and never mutates storage or cleanup jobs', async () => {
  stub(storage, 'listKyc', async function* () {
    for (const key of ['kyc/active', 'kyc/tracked', 'kyc/untracked', 'kyc/inflight', 'other/file']) yield { key, lastModified: old }
    yield { key: 'kyc/new', lastModified: new Date() }
    yield { key: 'kyc/unknown-age' }
  })
  stub(prisma.user, 'findFirst', async ({ where }: any) => where.OR[0].kycObjectKey === 'kyc/active' ? { id: 'active' } : null)
  stub(prisma.storageCleanup, 'findUnique', async ({ where }: any) => where.objectKey === 'kyc/inflight'
    ? { nextAttemptAt: new Date(Date.now() + 10000) }
    : where.objectKey === 'kyc/tracked' ? { nextAttemptAt: new Date(0) } : null)
  stub(prisma, '$transaction', async () => assert.fail('dry-run must not start a mutation transaction'))
  stub(storage, 'remove', async () => assert.fail('dry-run must never delete'))
  for (const method of ['create', 'updateMany', 'deleteMany', 'upsert']) {
    stub(prisma.storageCleanup, method, async () => assert.fail('dry-run must not modify jobs'))
  }
  const log: any[] = []
  const summary = await scanKycOrphans({ graceMs: 1000, log: entry => log.push(entry) })
  assert.equal(summary.mode, 'dry-run')
  assert.equal(summary.scanned, 7)
  assert.equal(summary.orphan, 2)
  assert.equal(summary.referenced, 1)
  assert.equal(summary.protected, 1)
  assert.equal(summary.tooYoung, 1)
  assert.equal(summary.skipped, 2)
  assert.equal(summary.deleted, 0)
  assert.deepEqual(log.filter(e => e.code === 'KYC_ORPHAN_CANDIDATE').map(e => e.objectKey), ['kyc/tracked', 'kyc/untracked'])
})

test('delete rechecks references under lock and continues after an individual delete failure', async () => {
  stub(storage, 'listKyc', async function* () {
    for (const key of ['kyc/committed', 'kyc/fails', 'kyc/orphan']) yield { key, lastModified: old }
  })
  stub(prisma.user, 'findFirst', async () => null)
  stub(prisma.storageCleanup, 'findUnique', async () => null)
  const removed: string[] = []
  stub(storage, 'remove', async (key: string) => {
    if (key === 'kyc/fails') throw new Error('Storage unavailable')
    removed.push(key)
  })
  stub(prisma, '$transaction', async (callback: any) => {
    let locked = false
    return callback({
      $queryRaw: async () => { locked = true; return [] },
      user: { findFirst: async ({ where }: any) => {
        assert.equal(locked, true)
        return where.OR[0].kycObjectKey === 'kyc/committed' ? { id: 'new reference' } : null
      } },
      storageCleanup: { findUnique: async () => null, deleteMany: async () => ({ count: 0 }) }
    })
  })
  const result = await scanKycOrphans({ dryRun: false, graceMs: 1000, log: quiet })
  assert.deepEqual(removed, ['kyc/orphan'])
  assert.equal(result.referenced, 1)
  assert.equal(result.failed, 1)
  assert.equal(result.deleted, 1)
})

test('reference failures never delete and invalid grace periods are rejected before scanning', async () => {
  stub(storage, 'listKyc', async function* () { yield { key: 'kyc/file', lastModified: old } })
  stub(prisma.user, 'findFirst', async () => { throw new Error('DB unavailable') })
  stub(storage, 'remove', async () => assert.fail('must fail closed'))
  const result = await scanKycOrphans({ dryRun: false, graceMs: 1000, log: quiet })
  assert.equal(result.failed, 1)
  assert.equal(result.deleted, 0)
  for (const graceMs of [0, -1, NaN, Infinity]) await assert.rejects(scanKycOrphans({ graceMs, log: quiet }))
})
