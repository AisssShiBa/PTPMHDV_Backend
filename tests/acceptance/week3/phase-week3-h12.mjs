// Week 3 / H12 runner: the C01-C15 cash-out matrix against a fresh isolated
// Compose project. Every result is answered by the stack this run started; no
// PASS is inferred from code that already exists. The Stack enables the durable
// mock bank only through a third compose file, because docker-compose.yml pins
// NODE_ENV=production and the mock refuses to run there by design.
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepare, command, hostReady, account, pause } from '../week2/runtime.mjs'
import { infrastructure, conservation } from '../week2/scenarios.mjs'
import { createRecorder } from './reporting.mjs'
import * as cashout from './cashout-scenarios.mjs'

const SCENARIOS = [
  ['C01', 'Amount 000: hold -> SUCCESS payout -> exactly one capture', cashout.c01],
  ['C02', 'Amount 111: hold -> FAILED payout -> release restores balance', cashout.c02],
  ['C03', 'Amount 222: UNKNOWN -> PAYOUT_PENDING -> query -> one capture', cashout.c03],
  ['C04', 'Two creates with one Idempotency-Key replay one CashOut', cashout.c04],
  ['C05', 'One key with a different amount is rejected with no effect', cashout.c05],
  ['C06', '20 parallel confirms with one token claim once', cashout.c06],
  ['C07', 'Token for another user/paymentId/amount answers 403', cashout.c07],
  ['C08', 'A token older than 60s answers 401 TXN_TOKEN_EXPIRED', cashout.c08],
  ['C09', 'A jti consumed by Payment is rejected for CashOut', cashout.c09],
  ['C10', 'Wallet down before Hold: no second hold, no payout without a hold', cashout.c10],
  ['C11', 'Crash after Mock SUCCESS: restart captures exactly once', cashout.c11],
  ['C12', 'Wallet dies after Capture: recovery adds no ledger rows', cashout.c12],
  ['C13', 'Hold survives the UNKNOWN window past its TTL and captures exactly once', cashout.c13],
  ['C14', 'USER and forged Gateway tokens cannot reach the mock payout', cashout.c14],
  ['C15', 'SUM(Wallet.balance)=0 and every transaction balances', cashout.c15],
  ['K12-COUNTERPARTY', 'Capture counterparty is the SYSTEM settlement wallet', cashout.k12Counterparty],
  ['GATEWAY-CASHOUT-ROUTE', 'POST /api/funding/cash-out honours the Gateway JWT contract', cashout.gatewayRoute]
]

// Docker Desktop's host port proxy can accept a TCP connection for a moment
// before the forwarded backend is reachable. Warm the path with bounded retries
// so no scenario inherits that transport blip.
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

// The stack under test needs the durable mock bank. NODE_ENV=test is the only
// switch that makes mockPayoutEnabled() true, and it is scoped to this project.
function enableMockBank(ctx) {
  const override = resolve(ctx.directory, 'h12-compose.json')
  writeFileSync(override, JSON.stringify({
    services: {
      'payment-service': {
        environment: [
          'NODE_ENV=test',
          'MOCK_PAYOUT_ENABLED=true',
          'CASHOUT_HOLD_TTL_MS=' + cashout.HOLD_TTL_MS
        ]
      }
    }
  }, null, 2))
  ctx.composeArgs.push('-f', override)
  return override
}

export async function runWeek3H12() {
  const args = process.argv.slice(2)
  const unknown = args.filter(arg => !['--keep', '--strict', '--no-build'].includes(arg))
  if (unknown.length) {
    console.error('Usage: node tests/acceptance/week3/phase-week3-h12.mjs [--keep] [--strict] [--no-build]')
    process.exit(1)
  }

  const ctx = await prepare()
  ctx.phase = 'week3-h12'
  ctx.title = '# Week 3 H12 cash-out acceptance'
  ctx.requests ??= []
  const override = enableMockBank(ctx)

  const recorder = createRecorder(ctx)
  const state = { successful: [], admin: null }
  let started = false

  console.log('Week 3 H12 project: ' + ctx.project)
  console.log('Evidence: ' + ctx.directory)
  console.log('Mock bank override: ' + override + ' (NODE_ENV=test, hold TTL ' + cashout.HOLD_TTL_MS + 'ms)')

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
      const seeded = await recorder.check({ id: 'SEED', scenario: 'Create the ADMIN funding account and prove the mock bank is live' },
        async () => {
          await warmGateway(ctx)
          state.admin = await account(ctx, 'h12-admin', undefined, 'ADMIN')
          const mock = await cashout.mockBankStatus(ctx)
          if (!mock.enabled) throw new Error('the mock payout provider is disabled: ' + JSON.stringify(mock))
          return { notes: 'ADMIN account ready; mock bank answers ' + mock.status + ' ' + (mock.code || '') }
        })
      if (!seeded) state.admin = null
    }

    if (state.admin) {
      for (const [id, scenario, fn] of SCENARIOS) {
        // Keep each scenario inside one Gateway rate-limit window.
        const recent = (ctx.requestTimes || []).filter(time => Date.now() - time < 61000)
        if (recent.length > 80) await pause(Math.max(0, recent[0] + 61000 - Date.now()))
        await recorder.check({ id, scenario }, () => fn(ctx, state))
      }
    }

    await recorder.check({ id: 'CONSERVATION', scenario: 'checkSystemConservation actual = 0 and SUM(Wallet.balance) = 0' },
      () => conservation(ctx))
  }

  // Anything that never ran is reported as BLOCKED, never silently dropped.
  const expected = ['COMPOSE', 'B6-7', 'SEED', ...SCENARIOS.map(([id]) => id), 'CONSERVATION']
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runWeek3H12()
