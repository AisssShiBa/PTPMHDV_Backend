import { transfer, checkout } from './p2p-scenarios.mjs'
import assert from 'node:assert/strict'
import { account, call, documents, sql, until, broker, pause, uuid, docker } from './runtime.mjs'

export class Blocked extends Error {}
const review = (ctx, admin, user, status) => call(ctx, '/admin/kyc/' + user.profileId + '/review', {
  method: 'POST', token: admin.token, body: { status }
})
const auditCount = (ctx, user, action) => Number(sql(ctx, 'admin_service',
  'SELECT count(*) FROM "AdminAuditLog" WHERE "targetId"=\'' + user.profileId + "\' AND action='" + action + "'"))
async function subject(ctx, label) {
  const user = await account(ctx, label)
  await call(ctx, '/users/kyc/documents', { method: 'POST', token: user.token, body: await documents(), expected: 202 })
  return user
}
export async function s11(ctx, accounts) {
  const user = await subject(ctx, 's11')
  assert.equal((await review(ctx, accounts.admin, user, 'APPROVED')).data.kycTier, 1)
  assert.equal((await review(ctx, accounts.admin, user, 'REJECTED')).data.kycTier, 0)
  const profile = (await call(ctx, '/users/me', { token: user.token })).data
  assert.equal(profile.kycTier, 0)
  assert.equal(profile.kycStatus, 'REJECTED')
  assert.equal(auditCount(ctx, user, 'APPROVE_KYC'), 1)
  assert.equal(auditCount(ctx, user, 'REJECT_KYC'), 1)
  await until(() => sql(ctx, 'user_service', "SELECT count(*) FROM user_outbox_events WHERE aggregate_id='" +
    user.profileId + "' AND status='PUBLISHED'") === '2', 'S11: publisher confirmations timed out')
  const events = JSON.parse(broker(ctx, "const events=[];let m;while(m=await ch.get('" + ctx.tierQueue +
    "',{noAck:true})){const e=JSON.parse(m.content.toString());if(e.data.authUserId==='" + user.id +
    "')events.push(e)}console.log(JSON.stringify(events));"))
  assert.deepEqual(events.map(e => [e.data.previousTier, e.data.kycTier]), [[0, 1], [1, 0]])
  assert.ok(events.every(e => e.eventType === 'user.kyc_updated' && e.eventVersion === 1 && e.occurredAt))
  assert.equal(new Set(events.map(e => e.eventId)).size, 2)
}
export async function s12(ctx, accounts) {
  const user = await account(ctx, 's12')
  await call(ctx, '/users/kyc/documents', {
    method: 'POST', token: user.token, body: await documents(false), expected: 400
  })
  await call(ctx, '/users/kyc/documents', {
    method: 'POST', token: user.token, body: await documents(), expected: 202
  })
  const path = '/admin/kyc/' + user.profileId + '/documents'
  await call(ctx, path, { token: accounts.binh.token, expected: 403 })
  await call(ctx, '/users/' + user.profileId + '/kyc/document', { token: accounts.binh.token, expected: 403 })
  await call(ctx, '/users/' + user.profileId + '/kyc/documents', { token: accounts.admin.token, expected: 403 })
  const issued = await call(ctx, path, { token: accounts.admin.token })
  assert.match(issued.headers.get('cache-control'), /no-store/)
  const urls = [issued.data.frontUrl, issued.data.backUrl]
  assert.notEqual(urls[0], urls[1])
  await Promise.all(urls.map(async url => {
    assert.equal(new URL(url).searchParams.get('X-Amz-Expires'), '2')
    assert.equal((await fetch(url, { signal: AbortSignal.timeout(5000) })).status, 200)
    const unsigned = new URL(url); unsigned.search = ''
    assert.equal((await fetch(unsigned, { signal: AbortSignal.timeout(5000) })).status, 403)
  }))
  await pause(Math.max(0, Date.parse(issued.data.expiresAt) - Date.now()) + 1200)
  for (const url of urls) assert.equal((await fetch(url, { signal: AbortSignal.timeout(5000) })).status, 403)
  await call(ctx, path, { token: accounts.admin.token })
  assert.equal(auditCount(ctx, user, 'VIEW_KYC_DOCUMENTS'), 2)
}
export async function s13(ctx, accounts) {
  const user = await account(ctx, 's13')
  await call(ctx, '/users/by-auth/' + accounts.binh.id, {
    method: 'PUT', token: accounts.binh.token, body: { fullName: 'Nguyễn Văn Bình' }
  })
  const path = '/users/lookup?q=' + encodeURIComponent(accounts.binh.email)
  const found = await call(ctx, path, { token: user.token })
  assert.deepEqual(found.data, { authUserId: accounts.binh.id, maskedName: 'Nguyễn V. B.' })
  const missing = await call(ctx, '/users/lookup?q=missing-' + uuid(), { token: user.token, expected: 404 })
  const self = await call(ctx, '/users/lookup?q=' + encodeURIComponent(user.email), { token: user.token, expected: 404 })
  assert.deepEqual(self.error, missing.error)
  for (let i = 0; i < 7; i++) await call(ctx, path, { token: user.token })
  const limited = await call(ctx, path, { token: user.token, expected: 429 })
  assert.equal(limited.error.code, 'RATE_LIMIT_EXCEEDED')
  assert.equal(limited.headers.get('retry-after'), '60')
}
export async function k1(ctx, accounts) {
  const user = await subject(ctx, 'k1')
  await call(ctx, '/wallets/' + user.id + '/credit', {
    method: 'POST', token: accounts.admin.token,
    body: { amount: '1250000', referenceId: 'k1-funding-' + uuid(), transferType: 'TOPUP' }
  })
  assert.equal((await call(ctx, '/users/me', { token: user.token })).data.kycTier, 0)
  await checkout(ctx, user, accounts.binh, '1000000', uuid(), 422)
  await call(ctx, '/admin/kyc/' + user.profileId + '/documents', { token: accounts.admin.token })
  assert.equal((await review(ctx, accounts.admin, user, 'APPROVED')).data.kycTier, 1)
  await until(() => sql(ctx, 'user_service', "SELECT count(*) FROM user_outbox_events WHERE aggregate_id='" +
    user.profileId + "' AND status='PUBLISHED'") === '1', 'K1: tier event was not published')
  const hasTier = sql(ctx, 'wallet_service',
    "SELECT count(*) FROM information_schema.columns WHERE table_name='Wallet' AND column_name='kycTier'") === '1'
  if (!hasTier) throw new Blocked('KYC approval/event passed; Wallet.kycTier and D12 consumer are absent. Cannot verify tier-based 1,000,000 VND P2P transfer.')
  await until(() => sql(ctx, 'wallet_service',
    `SELECT "kycTier" FROM "Wallet" WHERE "userId"='${user.id}' AND "ownerType"='USER'`) === '1',
    'K1: published KYC event did not update Wallet tier')
  await transfer(ctx, user, accounts.binh, '1000000')
}
export async function infrastructure(ctx) {
  for (const service of ['gateway', 'auth-service', 'user-service', 'merchant-service', 'admin-service',
    'wallet-service', 'payment-service', 'notification-service']) {
    assert.equal(docker(ctx, 'exec', '-T', service, 'node', '-e',
      "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exit(1);console.log('ok')}).catch(()=>process.exit(1))"), 'ok')
  }
  for (const service of ['user-publisher', 'user-consumer', 'merchant-publisher'])
    assert.ok(docker(ctx, 'ps', '--status', 'running', '-q', service), service + ' must be running')
}
export async function conservation(ctx) {
  const result = JSON.parse(docker(ctx, 'exec', '-T', 'wallet-service', 'node', '--import', 'tsx', '-e',
    "const {ReconciliationService}=require('./src/services/reconciliation.service');new ReconciliationService().checkSystemConservation().then(r=>{console.log(JSON.stringify(r));process.exit(0)}).catch(()=>process.exit(1))"))
  assert.equal(Number(result.actual), 0)
  assert.equal(result.isBalanced, true)
  assert.equal(Number(sql(ctx, 'wallet_service', 'SELECT COALESCE(SUM(balance),0) FROM "Wallet"')), 0)
}
export const pending = [
  ['A3', 'Dat', 'PIN lock and clock-controlled unlock'],
  ['A4', 'Dat', 'Single-use transaction token and expiry'],
  ['A9', 'Khoa', 'Tier-0 per-transaction/day limits'],
  ['R1', 'Nguyen', 'Socket notification within 3 seconds in at least 9/10 runs'],
  ...['S1','S2','S5','S10'].map(id => [id, 'Dat', 'Owner-provided week-2 security/consumer scenario']),
  ...['S3','S4','S6','S7','S8','S9','S15'].map(id => [id, 'Khoa', 'Owner-provided Wallet/Payment scenario']),
  ...['S14','S16'].map(id => [id, 'Nguyen', 'Owner-provided socket/broker recovery scenario'])
]

