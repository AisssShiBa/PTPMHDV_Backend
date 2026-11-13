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
import { contextFromProject, seedNguyen } from './seed-nguyen.mjs'

const require = createRequire(new URL('../../../services/user-service/package.json', import.meta.url))

test('seed module exports the Week-4 entry points', () => {
  assert.equal(typeof seedNguyen, 'function')
  assert.equal(typeof contextFromProject, 'function')
  assert.equal(KYC_SLOTS.length, 5)
  assert.equal(new Set(KYC_SLOTS.map((slot) => slot.email)).size, 5)
  assert.equal(new Set(KYC_SLOTS.map((slot) => slot.idNumber)).size, 5)
  for (const reserved of ['an@demo.vn', 'binh@demo.vn', 'chi@demo.vn', 'highlands@demo.vn', 'admin@demo.vn']) {
    assert.ok(!KYC_SLOTS.some((slot) => slot.email === reserved), reserved)
    assert.notEqual(DRIFT_SLOT.email, reserved)
  }
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
