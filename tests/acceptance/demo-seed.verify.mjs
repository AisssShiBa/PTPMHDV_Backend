import assert from 'node:assert/strict'
import { sql } from './week2/runtime.mjs'

export const namespace = 'demo-week4-v1'
export const targets = { an: '1250000.00', binh: '300000.00', chi: '100000.00' }

export function assertIsolated(ctx) {
  assert.match(ctx.project, /^finvault-acceptance-[0-9a-f]{12}$/)
}

// All queries are read-only. No credentials or document URLs enter the summary.
export function verifyDemo(ctx) {
  assertIsolated(ctx)
  const balances = {}
  // Auth IDs live in a different database, so resolve them without cross-DB joins.
  for (const name of Object.keys(targets)) {
    const id = sql(ctx, 'auth_service', `SELECT id FROM "User" WHERE email='${name}@demo.vn'`)
    assert.match(id, /^[0-9a-f-]{36}$/)
    balances[name] = sql(ctx, 'wallet_service', `SELECT balance::text FROM "Wallet" WHERE "userId"='${id}' AND "ownerType"='USER'`)
    assert.equal(balances[name], targets[name], name + ' balance')
    assert.equal(sql(ctx, 'user_service', `SELECT kyc_tier FROM users WHERE auth_user_id='${id}'`), String({ an: 2, binh: 1, chi: 0 }[name]), name + ' tier')
  }
  const counts = {
    baseAccounts: Number(sql(ctx, 'auth_service', `SELECT count(*) FROM "User" WHERE email IN ('admin@demo.vn','an@demo.vn','binh@demo.vn','chi@demo.vn','highlands@demo.vn')`)),
    merchants: Number(sql(ctx, 'merchant_service', 'SELECT count(*) FROM merchants')),
    highlandsOutlets: Number(sql(ctx, 'merchant_service', `SELECT count(*) FROM outlets o JOIN merchants m ON m.id=o.merchant_id WHERE m.business_name='Highlands Demo'`)),
    history: Number(sql(ctx, 'payment_service', `SELECT count(*) FROM "Payment" WHERE "idempotencyKey" LIKE '${namespace}-history-%' AND status='SUCCESS'`)),
    approvedTopups: Number(sql(ctx, 'payment_service', 'SELECT count(*) FROM "TopupRequest" WHERE status=\'APPROVED\''))
  }
  assert.deepEqual(counts, { baseAccounts: 5, merchants: 10, highlandsOutlets: 3, history: 50, approvedTopups: 3 })
  assert.equal(sql(ctx, 'wallet_service', 'SELECT COALESCE(SUM(balance),0)::numeric(20,2)::text FROM "Wallet"'), '0.00')
  assert.equal(sql(ctx, 'wallet_service', `SELECT count(*) FROM "Wallet" WHERE "ownerType" != 'SYSTEM' AND (balance < 0 OR "heldBalance" < 0 OR "heldBalance" > balance)`), '0')
  assert.equal(sql(ctx, 'wallet_service', `SELECT count(*) FROM (SELECT "transactionId" FROM "LedgerEntry" GROUP BY "transactionId" HAVING SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END) != 0 OR count(*) < 2) invalid`), '0')
  assert.equal(sql(ctx, 'wallet_service', `SELECT count(*) FROM "Wallet" w WHERE w.balance != COALESCE((SELECT SUM(CASE WHEN e.direction='CREDIT' THEN e.amount ELSE -e.amount END) FROM "LedgerEntry" e WHERE e."walletId"=w.id),0)`), '0', 'Each wallet balance must match its ledger')
  const codes = sql(ctx, 'payment_service', `SELECT code FROM "TopupRequest" WHERE status='APPROVED' ORDER BY code`).split('\n')
  for (const code of codes) {
    assert.match(code, /^NAP[0-9A-F]{8}$/)
    assert.equal(sql(ctx, 'wallet_service', `SELECT count(*) FROM "LedgerEntry" WHERE "referenceId"='${code}'`), '2')
    assert.equal(sql(ctx, 'wallet_service', `SELECT count(*) FROM "LedgerEntry" e JOIN "Wallet" w ON w.id=e."walletId" WHERE e."referenceId"='${code}' AND e.direction='DEBIT' AND w."systemCode"='CLEARING_TOPUP' AND e.amount=100000`), '1')
  }
  return { namespace, counts, balances, systemConservation: '0.00', intentionallyCorrupted: false,
    pending: ['Nguyen: five PENDING KYC profiles and isolated A8 scenario', 'Real VNPAY sandbox NOT_RUN; topups use synthetic HMAC'] }
}
