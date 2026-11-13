// Pure helpers for the Week-4 (N20) acceptance seed. Kept free of Docker and
// network access so the rules can be unit-tested on a machine without Compose.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const userServiceRequire = createRequire(
  new URL('../../../services/user-service/package.json', import.meta.url)
)

/** Upload limit enforced by user-service (`limits.fileSize` in its route). */
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024

/** Balance drift deliberately written by the seed, in VND. */
export const DRIFT_AMOUNT = '5000'

/** Real ledger credit given to each demo KYC account, in VND. */
export const KYC_CREDIT_AMOUNT = '50000'

/** Real ledger credit given to the drift account, in VND. */
export const DRIFT_CREDIT_AMOUNT = '200000'

/**
 * Five pending-KYC profiles with deterministic identities so a second run can
 * detect what already exists instead of creating duplicates. They are separate
 * from an/binh/chi/highlands/admin and from the SYSTEM wallet.
 */
export const KYC_SLOTS = [
  {
    key: 'kyc01',
    email: 'week4.kyc01@demo.vn',
    username: 'accept_week4_kyc01',
    fullName: 'KYC Demo 01',
    idNumber: '000000000401'
  },
  {
    key: 'kyc02',
    email: 'week4.kyc02@demo.vn',
    username: 'accept_week4_kyc02',
    fullName: 'KYC Demo 02',
    idNumber: '000000000402'
  },
  {
    key: 'kyc03',
    email: 'week4.kyc03@demo.vn',
    username: 'accept_week4_kyc03',
    fullName: 'KYC Demo 03',
    idNumber: '000000000403'
  },
  {
    key: 'kyc04',
    email: 'week4.kyc04@demo.vn',
    username: 'accept_week4_kyc04',
    fullName: 'KYC Demo 04',
    idNumber: '000000000404'
  },
  {
    key: 'kyc05',
    email: 'week4.kyc05@demo.vn',
    username: 'accept_week4_kyc05',
    fullName: 'KYC Demo 05',
    idNumber: '000000000405'
  }
]

export const DRIFT_SLOT = {
  key: 'drift',
  email: 'week4.drift@demo.vn',
  username: 'accept_week4_drift',
  fullName: 'Drift Demo',
  idNumber: '000000000499'
}

/**
 * The drift write is destructive to the reconciliation invariant, so it must be
 * impossible to reach by accident (plan N20). Production and any environment
 * without the explicit flag are refused before a single query is issued.
 */
export function assertDriftAllowed(env = process.env) {
  assert.notEqual(
    env.NODE_ENV,
    'production',
    'Refusing to seed a deliberate balance drift with NODE_ENV=production'
  )
  assert.equal(
    env.SEED_ALLOW_DRIFT,
    '1',
    'Refusing to seed a deliberate balance drift without SEED_ALLOW_DRIFT=1'
  )
}

/**
 * Idempotency planner: only slots whose auth email is still absent need a
 * signup. Running it twice over the same existing set yields the same answer.
 */
export function missingSlots(slots, existingEmails) {
  const existing = new Set(
    Array.from(existingEmails, (email) => String(email).trim().toLowerCase())
  )
  return slots.filter((slot) => !existing.has(slot.email.toLowerCase()))
}

/**
 * Documents are uploaded exactly once: only a profile that never submitted KYC
 * (NONE or no row) gets a new upload. PENDING/APPROVED/REJECTED are preserved so
 * a rerun cannot reset the review state.
 */
export function shouldUploadKyc(status) {
  return status === null || status === undefined || status === 'NONE'
}

/**
 * Parses an integral VND amount that PostgreSQL may render as `200000.00`.
 * Rejects fractions other than zeros so a decimal can never be silently
 * truncated.
 */
export function toBigIntMoney(value) {
  const text = String(value).trim()
  const match = /^([+-]?\d+)(?:\.(0+))?$/.exec(text)
  if (!match) throw new Error('Not an integral money string: ' + text)
  return BigInt(match[1])
}

/**
 * Decides whether the deliberate drift still has to be written. `balance` is
 * the wallet column, `ledgerTotal` is the signed sum of its ledger entries.
 * Values are money strings and are compared with BigInt, never Number.
 */
export function classifyDrift({ balance, ledgerTotal, expected = DRIFT_AMOUNT }) {
  const wallet = toBigIntMoney(balance)
  const ledger = toBigIntMoney(ledgerTotal)
  const wanted = toBigIntMoney(expected)
  if (wallet === ledger) return 'apply'
  if (wallet - ledger === wanted) return 'skip'
  throw new Error(
    'Unexpected drift state: wallet=' + wallet + ' ledger=' + ledger + ' expected delta=' + wanted
  )
}

/** Deterministic notification event id, so the notification inbox dedupes. */
export function notificationEventId(slotKey) {
  return 'week4-seed-' + slotKey + '-wallet-credited'
}

/**
 * Synthetic PNG for either side of an ID card. Generated from an SVG that
 * states it is not a real document; never a photo of a person. Both sides are
 * visually distinct and stay far below the 5 MB user-service limit.
 */
export async function syntheticDocument(slot, side) {
  assert.ok(['front', 'back'].includes(side), 'side must be front or back')
  const sharp = userServiceRequire('sharp')
  const accent = side === 'front' ? '#3b5bdb' : '#0b7285'
  const title = side === 'front' ? 'FRONT' : 'BACK'
  const svg = [
    '<svg width="900" height="560" xmlns="http://www.w3.org/2000/svg">',
    '<rect width="900" height="560" fill="#f4f5f7"/>',
    '<rect x="24" y="24" width="852" height="512" rx="18" fill="#ffffff" stroke="' + accent + '" stroke-width="4"/>',
    '<text x="60" y="110" font-family="Arial" font-size="40" fill="#1f2430">FINVAULT WEEK 4 SEED</text>',
    '<text x="60" y="165" font-family="Arial" font-size="26" fill="#c92a2a">SYNTHETIC IMAGE - NOT AN ID DOCUMENT</text>',
    '<text x="60" y="230" font-family="Arial" font-size="28" fill="#1f2430">' + slot.fullName + '</text>',
    '<text x="60" y="280" font-family="Arial" font-size="24" fill="#495057">Slot: ' + slot.key + ' / ' + title + '</text>',
    '<text x="60" y="330" font-family="Arial" font-size="24" fill="#495057">ID: ' + slot.idNumber + '</text>',
    '<rect x="60" y="380" width="780" height="110" rx="12" fill="' + accent + '" opacity="0.12"/>',
    '<text x="80" y="445" font-family="Arial" font-size="22" fill="' + accent + '">Generated by tests/acceptance/week4 - for local acceptance only</text>',
    '</svg>'
  ].join('')
  const buffer = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer()
  assert.ok(buffer.length <= MAX_DOCUMENT_BYTES, 'synthetic document exceeds the 5 MB limit')
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG')
  return buffer
}
