// Week 3 / H11 column-1 runner: one command, fresh isolated Compose project,
// real Gateway -> payment-service -> wallet-service -> PostgreSQL. Every result
// is answered by the stack in this run; nothing is inferred from code or logs.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepare, command, sql, hostReady, account, call, pause } from '../week2/runtime.mjs'
import { infrastructure, conservation } from '../week2/scenarios.mjs'
import { createRecorder, Blocked } from './reporting.mjs'
import * as vnpay from './vnpay-scenarios.mjs'

const LEGACY_CREATE = '/payments/topups'

// Docker Desktop's host port proxy can accept the TCP connection for a moment
// before the forwarded backend is reachable, which surfaces as a bare
// "fetch failed" with no request in the Gateway log. Warm the path with bounded
// retries before the matrix starts so no scenario inherits that transport blip.
async function warmGateway(ctx) {
  let lastError
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(ctx.base + '/health', { signal: AbortSignal.timeout(3000) })
      if (response.ok) return
      lastError = new Error('/health answered ' + response.status)
    } catch (error) {
      lastError = error
    }
    await pause(1000)
  }
  throw lastError ?? new Error('Gateway did not answer /health')
}

// The alias create route is public at the Gateway (another owner's whitelist),
// so a Bearer token never becomes an x-gateway-token there and requireGateway
// in payment-service rejects it. Probe it explicitly instead of hiding the gap
// inside V01-V12, which use the retained legacy create path.
async function aliasCreate(ctx, state) {
  const withoutBearer = await call(ctx, '/funding/vnpay/create',
    { method: 'POST', body: { amount: 100000 }, expected: null })
  const withBearer = await call(ctx, '/funding/vnpay/create',
    { method: 'POST', token: state.user.token, body: { amount: 100000 }, expected: null })

  if (withBearer.httpStatus === 401) {
    throw new Blocked('Gateway PUBLIC_ROUTES whitelist /^\\/api\\/funding(\\/.*)?$/ (owner: Dat) makes the alias ' +
      'create route public, so requireGateway sees no x-gateway-token: no Bearer=' + withoutBearer.httpStatus +
      ', Bearer=' + withBearer.httpStatus + ' (' + (withBearer.error?.code || 'no code') +
      '). IPN/return aliases remain usable because they authenticate by HMAC.')
  }
  if (withBearer.httpStatus !== 201) {
    throw new Error('alias create with Bearer returned ' + withBearer.httpStatus +
      ' (' + (withBearer.error?.code || 'no code') + ')')
  }
  return { httpStatus: withBearer.httpStatus, errorCode: withoutBearer.error?.code || null,
    notes: 'alias create reachable with Bearer; unauthenticated answered ' + withoutBearer.httpStatus }
}

const SCENARIOS = [
  ['V01', 'Valid paid IPN approves once with a balanced ledger', vnpay.v01],
  ['V02 (A6)', 'Sequential replay answers 00 then 02 with exactly one credit', vnpay.a6],
  ['V03', 'Twenty concurrent IPNs produce exactly one credit', vnpay.v03],
  ['V04', 'Forged checksum answers 97 and mutates nothing', vnpay.v04],
  ['V05', 'Amount mismatch answers 04 and never credits', vnpay.v05],
  ['V06', 'Foreign TmnCode answers 97 without crediting', vnpay.v06],
  ['V07', 'Unknown transaction reference answers 01', vnpay.v07],
  ['V09', 'Crash between wallet credit and status update recovers with one credit', vnpay.v09],
  ['V10', 'Alias and legacy IPN routes resolve to one transaction', vnpay.v10],
  ['V11', 'Create requires Bearer and the return URL never credits', vnpay.v11],
  ['V12', 'Amount bounds, query shape and canonical parameters are validated', vnpay.v12],
  ['V08 (A6-R)', 'Wallet outage answers 99/PROCESSING then recovery approves once', vnpay.a6r]
]

export async function runWeek3() {
  const args = process.argv.slice(2)
  const unknown = args.filter(arg => !['--keep', '--strict', '--no-build'].includes(arg))
  if (unknown.length) {
    console.error('Usage: node tests/acceptance/week3/phase-week3.mjs [--keep] [--strict] [--no-build]')
    process.exit(1)
  }

  const ctx = await prepare()
  ctx.phase = 'week3-h11'
  ctx.requests ??= []

  // The synthetic VNPAY terminal must exist before containers are created: the
  // Compose environment section reads VNP_TMN_CODE at container-create time and
  // scripts/init-secrets.js intentionally does not generate one.
  const envPath = resolve(ctx.directory, '.env')
  const envText = readFileSync(envPath, 'utf8')
  const patched = /^VNP_TMN_CODE=.*$/m.test(envText)
    ? envText.replace(/^VNP_TMN_CODE=.*$/m, 'VNP_TMN_CODE=' + vnpay.TMN)
    : envText.trimEnd() + '\nVNP_TMN_CODE=' + vnpay.TMN + '\n'
  writeFileSync(envPath, patched, { mode: 0o600 })
  ctx.config.VNP_TMN_CODE = vnpay.TMN
  ctx.env.VNP_TMN_CODE = vnpay.TMN
  ctx.createPath = LEGACY_CREATE

  const recorder = createRecorder(ctx)
  const state = {}
  let started = false

  console.log('Week 3 H11 project: ' + ctx.project)
  console.log('Evidence: ' + ctx.directory)
  console.log('VNPAY terminal: ' + vnpay.TMN + ' (synthetic; no sandbox is contacted)')

  try {
    await recorder.check({ id: 'COMPOSE', scenario: 'Build and start a fresh isolated stack with reachable host ports' }, async () => {
      const up = ['up', '-d']
      if (!args.includes('--no-build')) up.push('--build')
      up.push('--wait', '--wait-timeout', '480')
      await command(ctx, 'compose-up', 'docker', [...ctx.composeArgs, ...up])
      await hostReady(ctx)
      return { notes: ctx.project }
    })
    started = true
  } catch {
    started = false
  }

  if (started) {
    const healthy = await recorder.check({ id: 'B6-7', scenario: 'Compose workers, broker, storage and API health' },
      () => infrastructure(ctx))
    if (healthy) {
      // Reported through the recorder like every other check: a successful seed
      // is evidence too, and the backfill below would otherwise label it BLOCKED.
      const seeded = await recorder.check({ id: 'SEED', scenario: 'Create the acceptance account for the VNPAY matrix' },
        async () => {
          await warmGateway(ctx)
          vnpay.assertSetup(ctx)
          state.user = await account(ctx, 'h11')
          return { notes: 'account ready for the VNPAY matrix' }
        })
      if (!seeded) state.user = null
    }

    if (state.user) {
      for (const [id, scenario, fn] of SCENARIOS) {
        // Keep each scenario inside one Gateway rate-limit window.
        const recent = (ctx.requestTimes || []).filter(time => Date.now() - time < 61000)
        if (recent.length > 80) await pause(Math.max(0, recent[0] + 61000 - Date.now()))
        await recorder.check({ id, scenario }, () => fn(ctx, state))
      }
      await recorder.check({ id: 'GATEWAY-ALIAS-CREATE', scenario: 'POST /api/funding/vnpay/create honours the Gateway JWT contract' },
        () => aliasCreate(ctx, state))
    }

    await recorder.check({ id: 'CONSERVATION', scenario: 'checkSystemConservation actual = 0 and SUM(Wallet.balance) = 0' },
      () => conservation(ctx))
  }

  // Anything that never ran is reported as BLOCKED, never silently dropped.
  const expected = ['COMPOSE', 'B6-7', 'SEED', ...SCENARIOS.map(([id]) => id), 'GATEWAY-ALIAS-CREATE', 'CONSERVATION']
  for (const id of expected) {
    if (recorder.results.some(row => row.id === id)) continue
    recorder.results.push({ id, owner: 'Huu', scenario: 'Not executed', commit: recorder.commit,
      environment: ctx.project, startedAt: new Date().toISOString(), result: 'BLOCKED',
      reason: 'An earlier prerequisite failed before this check could run' })
    console.log('BLOCKED ' + id + ': earlier prerequisite failed')
  }

  if (!args.includes('--keep')) {
    await recorder.check({ id: 'STOP', scenario: 'Remove this project containers/networks; retain evidence and volumes' },
      () => command(ctx, 'compose-stop', 'docker', [...ctx.composeArgs, 'down', '--remove-orphans']))
  }

  const summary = results => ['PASS', 'FAIL', 'BLOCKED']
    .map(status => status + '=' + results.filter(row => row.result === status).length).join(', ')
  const report = recorder.write({ summary: summary(recorder.results) })
  console.log('Report: ' + resolve(ctx.directory, 'result.json'))
  console.log('Summary: ' + report.summary)

  const failed = recorder.results.filter(row => ['FAIL', 'BLOCKED'].includes(row.result))
  process.exitCode = failed.length === 0 ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runWeek3()
