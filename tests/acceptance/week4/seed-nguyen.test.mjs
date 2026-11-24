// Unit tests for the Week-4 (N20) seed rules. No Docker, PostgreSQL or Gateway
// is required: every rule below is pure or works on a synthetic buffer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  DRIFT_AMOUNT,
  DRIFT_SLOT,
  KYC_SLOTS,
  MAX_DOCUMENT_BYTES,
  assertDriftAllowed,
  classifyDrift,
  missingSlots,
  notificationEventId,
  shouldUploadKyc,
  syntheticDocument
} from './seed-lib.mjs'
import { contextFromProject, seedNguyen, seedNguyenDrift } from './seed-nguyen.mjs'
import { verifyDemo } from '../demo-seed.verify.mjs'
import { historyTransfers, matchesDemoDrift } from '../demo-seed.mjs'

const require = createRequire(new URL('../../../services/user-service/package.json', import.meta.url))

test('seed module exports the Week-4 entry points', () => {
  assert.equal(typeof seedNguyen, 'function')
  assert.equal(typeof seedNguyenDrift, 'function')
  assert.equal(typeof contextFromProject, 'function')
  assert.equal(KYC_SLOTS.length, 5)
  assert.equal(new Set(KYC_SLOTS.map((slot) => slot.email)).size, 5)
  assert.equal(new Set(KYC_SLOTS.map((slot) => slot.idNumber)).size, 5)
  for (const reserved of ['an@demo.vn', 'binh@demo.vn', 'chi@demo.vn', 'highlands@demo.vn', 'admin@demo.vn']) {
    assert.ok(!KYC_SLOTS.some((slot) => slot.email === reserved), reserved)
    assert.notEqual(DRIFT_SLOT.email, reserved)
  }
})

test('50 demo histories preserve each target balance and stay within the Auth PIN budget', () => {
  assert.equal(historyTransfers.length, 50)
  const net = { an: 0n, binh: 0n, chi: 0n }
  const verifies = { an: 0, binh: 0, chi: 0 }
  for (const [from, to] of historyTransfers) {
    assert.notEqual(from, to)
    net[from] -= 1000n
    net[to] += 1000n
    verifies[from]++
  }
  assert.deepEqual(net, { an: 0n, binh: 0n, chi: 0n })
  assert.ok(Object.values(verifies).every(count => count <= 20))
  assert.deepEqual(Object.values(verifies).sort(), [16, 17, 17])
})

test('A8 matches wallet and normalized Admin drift contracts without accepting another anomaly', () => {
  for (const type of ['BALANCE_DRIFT_QUICK', 'BALANCE_DRIFT_FULL']) {
    assert.equal(matchesDemoDrift({ walletId: 37, type }, '37'), true)
  }
  for (const mode of ['QUICK', 'FULL']) {
    assert.equal(matchesDemoDrift({ walletId: 37, type: 'BALANCE_DRIFT', detail: { mode } }, '37'), true)
  }
  assert.equal(matchesDemoDrift({ walletId: 38, type: 'BALANCE_DRIFT_FULL' }, '37'), false)
  assert.equal(matchesDemoDrift({ walletId: 37, type: 'BALANCE_DRIFT' }, '37'), false)
  assert.equal(matchesDemoDrift({ walletId: 37, type: 'NEGATIVE_BALANCE' }, '37'), false)
})

test('synthetic documents are PNG, 900x560, under 5 MB and side-specific', async () => {
  const slot = KYC_SLOTS[0]
  const front = await syntheticDocument(slot, 'front')
  const back = await syntheticDocument(slot, 'back')
  const sharp = require('sharp')

  for (const [buffer, side] of [[front, 'front'], [back, 'back']]) {
    assert.ok(Buffer.isBuffer(buffer))
    assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG', side)
    assert.ok(buffer.length > 0 && buffer.length <= MAX_DOCUMENT_BYTES, side)
    const metadata = await sharp(buffer).metadata()
    assert.equal(metadata.format, 'png')
    assert.equal(metadata.width, 900)
    assert.equal(metadata.height, 560)
  }
  assert.ok(!front.equals(back), 'front and back must not be identical images')
})

test('drift gate refuses production and any run without the explicit flag', () => {
  assert.throws(() => assertDriftAllowed({ NODE_ENV: 'production', SEED_ALLOW_DRIFT: '1' }), /production/)
  assert.throws(() => assertDriftAllowed({ NODE_ENV: 'development' }), /SEED_ALLOW_DRIFT=1/)
  assert.throws(() => assertDriftAllowed({ NODE_ENV: 'development', SEED_ALLOW_DRIFT: '0' }), /SEED_ALLOW_DRIFT=1/)
  assert.doesNotThrow(() => assertDriftAllowed({ NODE_ENV: 'development', SEED_ALLOW_DRIFT: '1' }))
  assert.doesNotThrow(() => assertDriftAllowed({ NODE_ENV: 'test', SEED_ALLOW_DRIFT: '1' }))
})

test('idempotency planner creates only missing slots and converges to empty', () => {
  const first = missingSlots(KYC_SLOTS, [])
  assert.deepEqual(first.map((slot) => slot.key), ['kyc01', 'kyc02', 'kyc03', 'kyc04', 'kyc05'])

  const partial = missingSlots(KYC_SLOTS, ['WEEK4.KYC02@demo.vn', 'week4.kyc04@demo.vn'])
  assert.deepEqual(partial.map((slot) => slot.key), ['kyc01', 'kyc03', 'kyc05'])

  const all = KYC_SLOTS.map((slot) => slot.email)
  const second = missingSlots(KYC_SLOTS, all)
  assert.equal(second.length, 0)
  // A rerun over the same inventory yields the same (empty) plan.
  assert.deepEqual(missingSlots(KYC_SLOTS, all).length, missingSlots(KYC_SLOTS, all).length)
})

test('KYC upload happens once: only NONE/absent state is uploadable', () => {
  assert.equal(shouldUploadKyc(null), true)
  assert.equal(shouldUploadKyc(undefined), true)
  assert.equal(shouldUploadKyc('NONE'), true)
  for (const status of ['PENDING', 'APPROVED', 'REJECTED']) {
    assert.equal(shouldUploadKyc(status), false, status)
  }
})

test('drift classifier applies once, skips on rerun and rejects unknown states', () => {
  assert.equal(classifyDrift({ balance: '205000', ledgerTotal: '200000' }), 'skip')
  assert.equal(classifyDrift({ balance: '200000', ledgerTotal: '200000' }), 'apply')
  assert.equal(classifyDrift({ balance: '200000.00', ledgerTotal: '200000.00' }), 'apply')
  const desired = String(BigInt(DRIFT_AMOUNT))
  assert.equal(
    classifyDrift({ balance: String(200000 + Number(desired)), ledgerTotal: '200000' }),
    'skip'
  )
  assert.throws(() => classifyDrift({ balance: '190000', ledgerTotal: '200000' }), /Unexpected drift state/)
  assert.throws(() => classifyDrift({ balance: '210000', ledgerTotal: '200000' }), /Unexpected drift state/)
})

test('notification event ids are deterministic and unique per slot', () => {
  const ids = KYC_SLOTS.map((slot) => notificationEventId(slot.key))
  assert.equal(new Set(ids).size, KYC_SLOTS.length)
  assert.equal(notificationEventId('kyc01'), notificationEventId('kyc01'))
  for (const id of ids) assert.match(id, /^week4-seed-[a-z0-9]+-wallet-credited$/)
})

test('contextFromProject rejects malformed or unknown projects without touching Docker', () => {
  assert.throws(() => contextFromProject('production'), /finvault-acceptance/)
  assert.throws(() => contextFromProject('finvault-acceptance-000000000000'), /Unknown acceptance project/)
})

const demoContext = { project: 'finvault-acceptance-123456abcdef' }
const fixtureIds = Object.fromEntries(['an', 'binh', 'chi', ...KYC_SLOTS.map(slot => slot.email), DRIFT_SLOT.email]
  .map((name, index) => [name.includes('@') ? name : name + '@demo.vn', `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]))

// Synthetic inventories exercise the verifier without creating data or using Docker.
function fixtureReader({ drift = false, override = () => undefined } = {}) {
  return (_ctx, database, statement) => {
    assert.match(statement, /^SELECT /, 'verification must remain read-only')
    const replacement = override(database, statement)
    if (replacement !== undefined) return replacement
    if (database === 'auth_service' && statement.startsWith('SELECT id ')) {
      return fixtureIds[statement.match(/email='([^']+)'/)[1]] ?? ''
    }
    if (statement.startsWith('SELECT kyc_tier')) {
      const id = statement.match(/auth_user_id='([^']+)'/)[1]
      return id === fixtureIds['an@demo.vn'] ? '2' : id === fixtureIds['binh@demo.vn'] ? '1' : '0'
    }
    if (statement.startsWith('SELECT balance::text')) {
      const id = statement.match(/"userId"='([^']+)'/)[1]
      const balances = { [fixtureIds['an@demo.vn']]: '1250000.00', [fixtureIds['binh@demo.vn']]: '300000.00', [fixtureIds['chi@demo.vn']]: '100000.00' }
      return balances[id] ?? '50000.00'
    }
    if (database === 'user_service' || database === 'notification_service') return '1'
    if (statement.includes('FROM "User" WHERE email IN')) return '5'
    if (statement === 'SELECT count(*) FROM merchants') return '10'
    if (statement.includes('FROM outlets')) return '3'
    if (statement.includes('FROM "Payment"')) return '50'
    if (statement === 'SELECT count(*) FROM "TopupRequest" WHERE status=\'APPROVED\'') return '3'
    if (statement.startsWith('SELECT code')) return 'NAP00000001\nNAP00000002\nNAP00000003'
    if (statement.startsWith('SELECT id::text')) return '99'
    if (statement.startsWith('SELECT (w.balance')) return drift ? '5000.00' : '0.00'
    if (statement.startsWith('SELECT COALESCE(SUM(balance)')) return drift ? '5000.00' : '0.00'
    if (statement.includes('FROM "Wallet" w WHERE w.balance')) return drift ? '1' : '0'
    if (statement.includes('"referenceId"') && statement.includes("'CLEARING_TOPUP'")) return '1'
    if (statement.includes('"referenceId"')) return '2'
    if (statement.includes('"LedgerEntry"') || statement.includes('"Wallet"')) return '0'
    assert.fail('Unhandled fixture query: ' + statement)
  }
}

test('combined H15/N20 verification requires all fixtures and can be repeated without writes', () => {
  const read = fixtureReader()
  const first = verifyDemo(demoContext, { read })
  assert.deepEqual(first.week4, { pendingKyc: 5, sampleNotifications: 5 })
  assert.equal(first.systemConservation, '0.00')
  assert.equal(first.intentionallyCorrupted, false)
  assert.deepEqual(verifyDemo(demoContext, { read }), first)
})

test('combined verification rejects a missing KYC side and a wrong notification owner', () => {
  for (const target of ['user_service', 'notification_service']) {
    const read = fixtureReader({ override: (db, query) => db === target &&
      (target === 'user_service' ? query.includes("kyc_status='PENDING'") : query.includes('AND "userId"')) ? '0' : undefined })
    assert.throws(() => verifyDemo(demoContext, { read }), target === 'user_service' ? /two uploaded KYC/ : /notification owner/)
  }
})

test('combined verification rejects duplicate sample notifications', () => {
  const read = fixtureReader({ override: (db, query) => db === 'notification_service' && !query.includes('AND "userId"') ? '2' : undefined })
  assert.throws(() => verifyDemo(demoContext, { read }), /exactly once/)
})

test('A8 verification permits only the designated drift and never calls it a clean baseline', () => {
  const read = fixtureReader({ drift: true })
  const summary = verifyDemo(demoContext, { read, includeDrift: true })
  assert.equal(summary.intentionallyCorrupted, true)
  assert.equal(summary.systemConservation, '5000.00')
  assert.equal(summary.driftWalletId, '99')
  assert.throws(() => verifyDemo(demoContext, { read }), /Total balance/)
  assert.throws(() => verifyDemo(demoContext, { read: fixtureReader(), includeDrift: true }), /designated A8 wallet/)
})

test('A8 verification rejects an additional wallet mismatch or unexplained money', () => {
  for (const target of ['mismatch', 'total']) {
    const read = fixtureReader({ drift: true, override: (_db, query) =>
      target === 'mismatch' && query.includes('FROM "Wallet" w WHERE w.balance') ? '2' :
      target === 'total' && query.startsWith('SELECT COALESCE(SUM(balance)') ? '10000.00' : undefined })
    assert.throws(() => verifyDemo(demoContext, { read, includeDrift: true }), /mismatch|Total balance/)
  }
})

test('drift refuses unsafe flags before looking up accounts or issuing SQL', async () => {
  for (const env of [{ NODE_ENV: 'production', SEED_ALLOW_DRIFT: '1' }, { NODE_ENV: 'test' }]) {
    await assert.rejects(seedNguyenDrift(demoContext, { env }), /production|SEED_ALLOW_DRIFT/)
    await assert.rejects(seedNguyen(demoContext, { env, includeDrift: true }), /production|SEED_ALLOW_DRIFT/)
  }
  assert.throws(() => verifyDemo({ project: 'production' }, { read: () => assert.fail('must not query') }), /finvault-acceptance/)
})
