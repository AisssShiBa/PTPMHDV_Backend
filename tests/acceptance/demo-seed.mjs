import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { prepare, command, hostReady, account, call, documents, sql } from './week2/runtime.mjs'
import { checkout, confirm } from './week2/p2p-scenarios.mjs'
import { signVnpay, TMN } from './week3/vnpay-scenarios.mjs'
import { assertIsolated, namespace, targets, verifyDemo } from './demo-seed.verify.mjs'
import { seedNguyen, seedNguyenDrift } from './week4/seed-nguyen.mjs'
import { assertDriftAllowed, DRIFT_AMOUNT, DRIFT_SLOT } from './week4/seed-lib.mjs'

const save = (directory, name, data) => writeFileSync(resolve(directory, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })

// 25 round trips keep all three target balances unchanged. Each sender verifies
// at most 17 PINs, below Auth's 20-per-15-minute budget.
export const historyTransfers = Array.from({ length: 50 }, (_, index) => {
  const pair = [['an', 'binh'], ['binh', 'chi'], ['chi', 'an']][Math.floor(index / 2) % 3]
  return index % 2 ? [...pair].reverse() : [...pair]
})

export function matchesDemoDrift(anomaly, walletId) {
  return String(anomaly.walletId) === String(walletId) && (
    ['BALANCE_DRIFT_QUICK', 'BALANCE_DRIFT_FULL'].includes(anomaly.type) ||
    (anomaly.type === 'BALANCE_DRIFT' && ['QUICK', 'FULL'].includes(anomaly.detail?.mode))
  )
}

async function demoAdmin(ctx) {
  const { admin } = JSON.parse(readFileSync(resolve(ctx.directory, 'demo-accounts.json'), 'utf8'))
  assert.ok(admin?.username && admin?.password, 'Demo admin credentials missing')
  const login = await call(ctx, '/auth/signin', { method: 'POST', body: { username: admin.username, password: admin.password } })
  assert.ok(login.data?.accessToken, 'Demo admin signin failed')
  return login.data.accessToken
}

async function baselineReport(ctx, token) {
  const { data } = await call(ctx, '/admin/reconciliation/run?mode=full', { method: 'POST', token })
  assert.equal(data?.isBalanced, true, 'RC1 baseline must be balanced before A8')
  assert.equal(data.anomaliesFound, 0, 'RC1 baseline must report zero anomalies')
  assert.ok(Array.isArray(data.anomalies) && data.anomalies.length === 0, 'RC1 baseline must have no anomalies')
  return { id: data.id, isBalanced: true, anomalies: 0 }
}

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
    // Keep VND canonical; the current backend also accepts bounded legacy integers.
    const created = (await call(ctx, '/payments/topups', {
      method: 'POST', token: accounts[name].token, body: { amount: '100000' }, expected: 201
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
  // Also respect Gateway's per-user PIN budget without disabling rate limits.
  const pinTimes = new Map()
  for (const [i, [from, to]] of historyTransfers.entries()) {
    const [sender, receiver] = [accounts[from], accounts[to]]
    let recent = (pinTimes.get(from) ?? []).filter(time => Date.now() - time < 61_000)
    if (recent.length >= 9) await delay(Math.max(0, recent[0] + 61_000 - Date.now()))
    recent = recent.filter(time => Date.now() - time < 61_000)
    pinTimes.set(from, [...recent, Date.now()])
    const payment = (await checkout(ctx, sender, receiver, '1000', namespace + '-history-' + String(i).padStart(2, '0'))).data
    assert.equal((await confirm(ctx, sender, payment)).data.status, 'SUCCESS')
  }
  const adminToken = await demoAdmin(ctx)
  await seedNguyen(ctx, { adminToken, includeDrift: false })
  const summary = verifyDemo(ctx)
  return { ...summary, rc1: await baselineReport(ctx, adminToken) }
}

// Deliberately corrupt only the N20 fixture after verifying a clean baseline.
// Repeating this stage must never add the drift amount again.
export async function prepareDemoDrift(ctx) {
  assertIsolated(ctx)
  assertDriftAllowed(process.env)
  const token = await demoAdmin(ctx)
  const existing = sql(ctx, 'auth_service', `SELECT id FROM "User" WHERE email='${DRIFT_SLOT.email}'`)
  let alreadyDrifted = false
  if (existing) {
    assert.match(existing, /^[0-9a-f-]{36}$/)
    const delta = sql(ctx, 'wallet_service', `SELECT (w.balance - COALESCE((SELECT SUM(CASE WHEN e.direction='CREDIT' THEN e.amount ELSE -e.amount END) FROM "LedgerEntry" e WHERE e."walletId"=w.id),0))::numeric(20,2)::text FROM "Wallet" w WHERE w."userId"='${existing}' AND w."ownerType"='USER'`)
    assert.ok(['', '0.00', DRIFT_AMOUNT + '.00'].includes(delta), 'Unexpected existing drift; inspect the test fixture')
    alreadyDrifted = delta === DRIFT_AMOUNT + '.00'
  }
  if (!alreadyDrifted) {
    verifyDemo(ctx)
    save(ctx.directory, 'demo-rc1-before-drift.json', await baselineReport(ctx, token))
    await seedNguyenDrift(ctx, { adminToken: token })
  }
  const summary = verifyDemo(ctx, { includeDrift: true })
  const { data } = await call(ctx, '/admin/reconciliation/run?mode=full', { method: 'POST', token })
  assert.equal(data?.isBalanced, false, 'A8 fixture must be detected by reconciliation')
  // Run returns the report summary; W3 carries the actual anomaly details.
  const detail = await call(ctx, '/admin/reconciliation/reports/' + data.id, { token })
  const anomaly = detail.data?.anomalies?.find(item => matchesDemoDrift(item, summary.driftWalletId))
  assert.ok(anomaly, 'A8 drift anomaly missing for the designated wallet')
  return { ...summary, driftAppliedNow: !alreadyDrifted, reconciliation: { reportId: data.id, anomalyId: anomaly.id } }
}

export async function runDemo(args = process.argv.slice(2)) {
  const [mode, ...rest] = args
  assert.ok(['fresh', 'verify-only', 'a8'].includes(mode), 'Usage: demo-seed.mjs fresh [--no-build] | verify-only <run-directory> [--drift] | a8 <run-directory>')
  if (mode === 'verify-only' || mode === 'a8') {
    assert.ok(rest.length === 1 || (mode === 'verify-only' && rest.length === 2 && rest[1] === '--drift'), 'Expected one run directory and optional --drift for verify-only')
    if (mode === 'a8') assertDriftAllowed(process.env)
    const directory = resolve(rest[0])
    const record = JSON.parse(readFileSync(resolve(directory, 'demo-context.json'), 'utf8'))
    assertIsolated(record)
    const config = parseEnv(readFileSync(resolve(directory, '.env'), 'utf8'))
    const ctx = { ...record, directory, config, base: record.base ?? 'http://127.0.0.1:' + config.GATEWAY_PORT,
      env: { ...process.env, ...config, COMPOSE_PROJECT_NAME: record.project }, requests: [] }
    const summary = mode === 'a8' ? await prepareDemoDrift(ctx) : verifyDemo(ctx, { includeDrift: rest[1] === '--drift' })
    save(directory, mode === 'a8' ? 'demo-drift.json' : 'seed-summary.json', summary)
    console.log(mode === 'a8' ? 'PASS A8 fixture detected (adjustment is a separate acceptance step): ' + directory : 'PASS verify-only: ' + directory)
    return
  }
  assert.ok(rest.every(arg => arg === '--no-build'), 'Unknown fresh option')
  // Fail before generating any secrets when Docker is inaccessible.
  execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'pipe' })
  const ctx = await prepare()
  const envPath = resolve(ctx.directory, '.env')
  writeFileSync(envPath, readFileSync(envPath, 'utf8') + '\nVNP_TMN_CODE=' + TMN + '\n', { mode: 0o600 })
  ctx.config.VNP_TMN_CODE = ctx.env.VNP_TMN_CODE = TMN
  save(ctx.directory, 'demo-context.json', { project: ctx.project, composeArgs: ctx.composeArgs, base: ctx.base })
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
