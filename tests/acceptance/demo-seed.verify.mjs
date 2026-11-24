import assert from 'node:assert/strict'
import { sql } from './week2/runtime.mjs'
import { DRIFT_AMOUNT, DRIFT_SLOT, KYC_CREDIT_AMOUNT, KYC_SLOTS, notificationEventId } from './week4/seed-lib.mjs'

export const namespace = 'demo-week4-v1'
export const targets = { an: '1250000.00', binh: '300000.00', chi: '100000.00' }

export function assertIsolated(ctx) {
  assert.match(ctx.project, /^finvault-acceptance-[0-9a-f]{12}$/)
}

// All queries are read-only. No credentials or document URLs enter the summary.
export function verifyDemo(ctx, { includeDrift = false, read = sql } = {}) {
  assertIsolated(ctx)
  const balances = {}
  // Auth IDs live in a different database, so resolve them without cross-DB joins.
  for (const name of Object.keys(targets)) {
    const id = read(ctx, 'auth_service', `SELECT id FROM "User" WHERE email='${name}@demo.vn'`)
    assert.match(id, /^[0-9a-f-]{36}$/)
    balances[name] = read(ctx, 'wallet_service', `SELECT balance::text FROM "Wallet" WHERE "userId"='${id}' AND "ownerType"='USER'`)
    assert.equal(balances[name], targets[name], name + ' balance')
    assert.equal(read(ctx, 'user_service', `SELECT kyc_tier FROM users WHERE auth_user_id='${id}'`), String({ an: 2, binh: 1, chi: 0 }[name]), name + ' tier')
  }
  const counts = {
    baseAccounts: Number(read(ctx, 'auth_service', `SELECT count(*) FROM "User" WHERE email IN ('admin@demo.vn','an@demo.vn','chi@demo.vn','binh@demo.vn','highlands@demo.vn')`)),
    merchants: Number(read(ctx, 'merchant_service', 'SELECT count(*) FROM merchants')),
    highlandsOutlets: Number(read(ctx, 'merchant_service', `SELECT count(*) FROM outlets o JOIN merchants m ON m.id=o.merchant_id WHERE m.business_name='Highlands Demo'`)),
    history: Number(read(ctx, 'payment_service', `SELECT count(*) FROM "Payment" WHERE "idempotencyKey" LIKE '${namespace}-history-%' AND status='SUCCESS'`)),
    approvedTopups: Number(read(ctx, 'payment_service', 'SELECT count(*) FROM "TopupRequest" WHERE status=\'APPROVED\''))
  }
  assert.deepEqual(counts, { baseAccounts: 5, merchants: 10, highlandsOutlets: 3, history: 50, approvedTopups: 3 })
  const week4 = { pendingKyc: 0, sampleNotifications: 0 }
  for (const slot of KYC_SLOTS) {
    const id = read(ctx, 'auth_service', `SELECT id FROM "User" WHERE email='${slot.email}'`)
    assert.match(id, /^[0-9a-f-]{36}$/, slot.key + ' Auth account missing')
    assert.equal(read(ctx, 'user_service', `SELECT count(*) FROM users WHERE auth_user_id='${id}' AND kyc_status='PENDING' AND kyc_object_key IS NOT NULL AND kyc_back_object_key IS NOT NULL AND id_number='${slot.idNumber}'`), '1', slot.key + ' must have two uploaded KYC sides and be PENDING')
    assert.equal(read(ctx, 'wallet_service', `SELECT balance::text FROM "Wallet" WHERE "userId"='${id}' AND "ownerType"='USER'`), KYC_CREDIT_AMOUNT + '.00', slot.key + ' balance')
    const eventId = notificationEventId(slot.key)
    assert.equal(read(ctx, 'notification_service', `SELECT count(*) FROM "Notification" WHERE "eventId"='${eventId}'`), '1', slot.key + ' sample notification must exist exactly once')
    assert.equal(read(ctx, 'notification_service', `SELECT count(*) FROM "Notification" WHERE "eventId"='${eventId}' AND "userId"='${id}' AND type='WALLET_CREDITED'`), '1', slot.key + ' notification owner/type')
    week4.pendingKyc++
    week4.sampleNotifications++
  }
  let driftWalletId = null
  if (includeDrift) {
    const id = read(ctx, 'auth_service', `SELECT id FROM "User" WHERE email='${DRIFT_SLOT.email}'`)
    assert.match(id, /^[0-9a-f-]{36}$/, 'A8 drift account missing')
    driftWalletId = read(ctx, 'wallet_service', `SELECT id::text FROM "Wallet" WHERE "userId"='${id}' AND "ownerType"='USER'`)
    assert.match(driftWalletId, /^\d+$/)
    assert.equal(read(ctx, 'wallet_service', `SELECT (w.balance - COALESCE((SELECT SUM(CASE WHEN e.direction='CREDIT' THEN e.amount ELSE -e.amount END) FROM "LedgerEntry" e WHERE e."walletId"=w.id),0))::numeric(20,2)::text FROM "Wallet" w WHERE w.id=${driftWalletId}`), DRIFT_AMOUNT + '.00', 'Only the designated A8 wallet may drift')
  }
  const totalBalance = read(ctx, 'wallet_service', 'SELECT COALESCE(SUM(balance),0)::numeric(20,2)::text FROM "Wallet"')
  assert.equal(totalBalance, includeDrift ? DRIFT_AMOUNT + '.00' : '0.00', 'Total balance must equal only the deliberate drift')
  assert.equal(read(ctx, 'wallet_service', `SELECT count(*) FROM "Wallet" WHERE "ownerType" != 'SYSTEM' AND (balance < 0 OR "heldBalance" < 0 OR "heldBalance" > balance)`), '0')
  assert.equal(read(ctx, 'wallet_service', `SELECT count(*) FROM (SELECT "transactionId" FROM "LedgerEntry" GROUP BY "transactionId" HAVING SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END) != 0 OR count(*) < 2) invalid`), '0')
  assert.equal(read(ctx, 'wallet_service', `SELECT count(*) FROM "Wallet" w WHERE w.balance != COALESCE((SELECT SUM(CASE WHEN e.direction='CREDIT' THEN e.amount ELSE -e.amount END) FROM "LedgerEntry" e WHERE e."walletId"=w.id),0)`), includeDrift ? '1' : '0', 'Unexpected wallet/ledger mismatch')
  const codes = read(ctx, 'payment_service', `SELECT code FROM "TopupRequest" WHERE status='APPROVED' ORDER BY code`).split('\n')
  for (const code of codes) {
    assert.match(code, /^NAP[0-9A-F]{8}$/)
    assert.equal(read(ctx, 'wallet_service', `SELECT count(*) FROM "LedgerEntry" WHERE "referenceId"='${code}'`), '2')
    assert.equal(read(ctx, 'wallet_service', `SELECT count(*) FROM "LedgerEntry" e JOIN "Wallet" w ON w.id=e."walletId" WHERE e."referenceId"='${code}' AND e.direction='DEBIT' AND w."systemCode"='CLEARING_TOPUP' AND e.amount=100000`), '1')
  }
  return { namespace, counts, balances, week4, systemConservation: totalBalance,
    intentionallyCorrupted: includeDrift, driftWalletId,
    pending: ['Real VNPAY sandbox NOT_RUN; topups use synthetic HMAC'] }
}
