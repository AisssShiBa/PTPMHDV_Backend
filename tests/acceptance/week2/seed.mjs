import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { account, call, documents, broker, sql, until, uuid } from './runtime.mjs'

export async function seed(ctx) {
  assert.match(ctx.project, /^finvault-acceptance-[0-9a-f]{12}$/)
  // This seed only runs inside a newly created project. Never overwrites a demo user.
  assert.equal(sql(ctx, 'auth_service', 'SELECT count(*) FROM "User"'), '0', 'Seed requires a fresh acceptance DB')
  const queue = 'acceptance-tier-' + uuid()
  broker(ctx, "await ch.assertExchange('finvault.events','topic',{durable:true});await ch.assertQueue('" + queue +
    "',{durable:false,arguments:{'x-expires':3600000}});await ch.bindQueue('" + queue + "','finvault.events','user.kyc_updated');")
  ctx.tierQueue = queue
  const accounts = {}
  for (const name of ['admin', 'an', 'binh', 'chi', 'highlands'])
    accounts[name] = await account(ctx, name, name + '@demo.vn', name === 'admin' ? 'ADMIN' : 'USER')
  for (const [name, tier, balance] of [['an', 2, 1250000], ['binh', 1, 300000], ['chi', 0, 100000]]) {
    const user = accounts[name]
    if (tier) {
      await call(ctx, '/users/kyc/documents', { method: 'POST', token: user.token, body: await documents(), expected: 202 })
      await call(ctx, '/admin/kyc/' + user.profileId + '/review', {
        method: 'POST', token: accounts.admin.token, body: { status: 'APPROVED' }
      })
      if (tier === 2) await call(ctx, '/admin/kyc/' + user.profileId + '/tier', {
        method: 'PATCH', token: accounts.admin.token, body: { tier: 2, reason: 'Synthetic bank link for acceptance seed' }
      })
    }
    // Use the real ledger API: funding has a matching system-wallet debit.
    await call(ctx, '/wallets/' + user.id + '/credit', {
      method: 'POST', token: accounts.admin.token,
      body: { amount: String(balance), referenceId: 'seed-' + name, transferType: 'TOPUP' }
    })
    assert.equal(Number((await call(ctx, '/wallets/' + user.id + '/balance', { token: user.token })).data.balance), balance)
    assert.equal((await call(ctx, '/users/me', { token: user.token })).data.kycTier, tier)
  }
  const merchant = (await call(ctx, '/merchants/register', {
    method: 'POST', token: accounts.highlands.token, expected: 201,
    body: { businessName: 'Highlands Demo' }
  })).data
  await call(ctx, '/admin/merchants/' + merchant.id + '/review', {
    method: 'POST', token: accounts.admin.token, body: { status: 'APPROVED' }
  })
  accounts.highlands.merchantId = merchant.id
  // Auth currently has USER/ADMIN roles; merchant ownership is in merchant-service.
  // No synthetic MERCHANT role, wallet consumer or QR is injected to hide missing H9/D12.
  await until(() => sql(ctx, 'merchant_service', "SELECT count(*) FROM merchant_outbox_events WHERE aggregate_id='" +
    merchant.id + "' AND event_type='merchant.status_updated' AND status='PUBLISHED'") === '1', 'Merchant approval was not published')
  assert.equal(Number(sql(ctx, 'wallet_service', 'SELECT COALESCE(SUM(balance),0) FROM "Wallet"')), 0)
  writeFileSync(resolve(ctx.directory, 'accounts.json'), JSON.stringify(accounts, null, 2), { mode: 0o600 })
  writeFileSync(resolve(ctx.directory, 'seed-result.json'), JSON.stringify({
    accounts: Object.entries(accounts).map(([name, value]) => ({ name, email: value.email, id: value.id, merchantId: value.merchantId })),
    balances: { an: 1250000, binh: 300000, chi: 100000 }, tiers: { an: 2, binh: 1, chi: 0 },
    systemConservation: 0,
    outstanding: ['Highlands merchant wallet/QR require D12/H9; no fake wallet or QR seeded']
  }, null, 2))
  return accounts
}

