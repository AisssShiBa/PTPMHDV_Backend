import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import { prepare, command, hostReady, account, call, documents, sql } from './week2/runtime.mjs'
import { checkout, confirm } from './week2/p2p-scenarios.mjs'
import { signVnpay, TMN } from './week3/vnpay-scenarios.mjs'
import { assertIsolated, namespace, targets, verifyDemo } from './demo-seed.verify.mjs'

const save = (directory, name, data) => writeFileSync(resolve(directory, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })

export async function seedDemo(ctx) {
  assertIsolated(ctx)
  assert.equal(sql(ctx, 'auth_service', 'SELECT count(*) FROM "User"'), '0', 'fresh requires an empty Auth DB; use verify-only for existing seed')
  const accounts = {}
  for (const name of ['admin', 'an', 'binh', 'chi', 'highlands']) {
    accounts[name] = await account(ctx, name, name + '@demo.vn', name === 'admin' ? 'ADMIN' : 'USER')
    // Preserve generated credentials after every principal, even on partial failure.
    save(ctx.directory, 'demo-accounts.json', accounts)
  }
  for (const [name, tier] of [['an', 2], ['binh', 1]]) {
    await call(ctx, '/users/kyc/documents', { method: 'POST', token: accounts[name].token, body: await documents(), expected: 202 })
    await call(ctx, '/admin/kyc/' + accounts[name].profileId + '/review', {
      method: 'POST', token: accounts.admin.token, body: { status: 'APPROVED' }
    })
    if (tier === 2) await call(ctx, '/admin/kyc/' + accounts[name].profileId + '/tier', {
      method: 'PATCH', token: accounts.admin.token, body: { tier, reason: 'Synthetic demo tier fixture' }
    })
  }
  // Reserve 100,000 VND of each target for a real backend IPN credit below.
  for (const [name, amount] of Object.entries(targets)) {
    const initial = BigInt(amount.split('.')[0]) - 100000n
    if (initial > 0n) await call(ctx, '/wallets/' + accounts[name].id + '/credit', {
      method: 'POST', token: accounts.admin.token,
      body: { amount: String(initial), referenceId: namespace + '-initial-' + name, transferType: 'TOPUP' }
    })
    // Current backend contract is number. Do not change payment owner's contract here.
    const created = (await call(ctx, '/payments/topups', {
      method: 'POST', token: accounts[name].token, body: { amount: 100000 }, expected: 201
    })).data
    const code = new URL(created.paymentUrl).searchParams.get('vnp_TxnRef')
    assert.ok(code)
    const params = { vnp_TmnCode: TMN, vnp_TxnRef: code, vnp_Amount: '10000000',
      vnp_ResponseCode: '00', vnp_TransactionStatus: '00', vnp_TransactionNo: 'DEMO-' + name,
      vnp_BankCode: 'NCB', vnp_PayDate: '20261111120000' }
    const path = '/funding/vnpay/ipn?' + new URLSearchParams({ ...params, vnp_SecureHash: signVnpay(params, ctx.config.VNP_HASH_SECRET) })
    assert.equal((await call(ctx, path)).RspCode, '00')
    assert.equal((await call(ctx, path)).RspCode, '02', 'IPN replay must not credit twice')
  }
  for (let i = 0; i < 10; i++) {
    const name = i === 0 ? 'highlands' : 'merchant' + i
    const owner = accounts[name] ?? await account(ctx, name, name + '@demo.vn')
    accounts[name] = owner
    save(ctx.directory, 'demo-accounts.json', accounts)
    const merchant = (await call(ctx, '/merchants/register', { method: 'POST', token: owner.token, expected: 201,
      body: { businessName: i === 0 ? 'Highlands Demo' : 'Demo Merchant ' + i } })).data
    await call(ctx, '/merchants/' + merchant.id + '/status', { method: 'PATCH', token: accounts.admin.token, body: { status: 'APPROVED' } })
    for (let outlet = 1; outlet <= (i === 0 ? 3 : 1); outlet++) {
      const created = (await call(ctx, '/merchants/' + merchant.id + '/outlets', { method: 'POST', token: owner.token,
        expected: 201, body: { name: 'Demo outlet ' + outlet, code: namespace + '-m' + i + '-o' + outlet } })).data
      await call(ctx, '/merchants/' + merchant.id + '/outlets/' + created.id + '/qr', { token: owner.token })
    }
  }
  // 25 round trips create 50 real payment histories while preserving target balances.
  for (let i = 0; i < 50; i++) {
    const [sender, receiver] = i % 2 ? [accounts.binh, accounts.an] : [accounts.an, accounts.binh]
    const payment = (await checkout(ctx, sender, receiver, '1000', namespace + '-history-' + String(i).padStart(2, '0'))).data
    assert.equal((await confirm(ctx, sender, payment)).data.status, 'SUCCESS')
  }
  return verifyDemo(ctx)
}

export async function runDemo(args = process.argv.slice(2)) {
  const [mode, ...rest] = args
  assert.ok(['fresh', 'verify-only'].includes(mode), 'Usage: demo-seed.mjs fresh [--no-build] | verify-only <run-directory>')
  if (mode === 'verify-only') {
    assert.equal(rest.length, 1)
    const directory = resolve(rest[0])
    const record = JSON.parse(readFileSync(resolve(directory, 'demo-context.json'), 'utf8'))
    assertIsolated(record)
    const config = parseEnv(readFileSync(resolve(directory, '.env'), 'utf8'))
    const ctx = { ...record, directory, env: { ...process.env, ...config, COMPOSE_PROJECT_NAME: record.project } }
    const summary = verifyDemo(ctx)
    save(directory, 'seed-summary.json', summary)
    console.log('PASS verify-only: ' + directory)
    return
  }
  assert.ok(rest.every(arg => arg === '--no-build'), 'Unknown fresh option')
  // Fail before generating any secrets when Docker is inaccessible.
  execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'pipe' })
  const ctx = await prepare()
  const envPath = resolve(ctx.directory, '.env')
  writeFileSync(envPath, readFileSync(envPath, 'utf8') + '\nVNP_TMN_CODE=' + TMN + '\n', { mode: 0o600 })
  ctx.config.VNP_TMN_CODE = ctx.env.VNP_TMN_CODE = TMN
  save(ctx.directory, 'demo-context.json', { project: ctx.project, composeArgs: ctx.composeArgs })
  console.log('Isolated demo project: ' + ctx.project + '\nEvidence: ' + ctx.directory)
  try {
    const up = ['up', '-d', ...(rest.includes('--no-build') ? [] : ['--build']), '--wait', '--wait-timeout', '480']
    await command(ctx, 'demo-compose-up', 'docker', [...ctx.composeArgs, ...up])
    await hostReady(ctx)
    save(ctx.directory, 'seed-summary.json', await seedDemo(ctx))
    console.log('PASS fresh; stack retained for demo and verify-only')
  } catch {
    save(ctx.directory, 'seed-status.json', { status: 'BLOCKED', namespace, reason: 'Seed did not complete; inspect private run logs. Do not rerun fresh against this database.' })
    throw new Error('Demo seed blocked; evidence: ' + ctx.directory)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runDemo() } catch (error) {
    console.error(error.code === 'EACCES' || error.status ? 'BLOCKED: Docker unavailable; no acceptance verdict.' : error.message)
    process.exitCode = 1
  }
}
