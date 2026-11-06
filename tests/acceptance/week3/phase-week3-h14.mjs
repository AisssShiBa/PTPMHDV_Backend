// Week 3 / H14 runner: the K01-K08 KYC matrix against a fresh isolated Compose
// project. Every result is answered by the stack this run started; no PASS is
// inferred from code that already exists. Items the plan keeps open (the review
// event, the PENDING-tier policy) surface as BLOCKED with live evidence, never
// as PASS.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepare, command, hostReady, account, pause } from '../week2/runtime.mjs'
import { infrastructure, conservation } from '../week2/scenarios.mjs'
import { createRecorder } from './reporting.mjs'
import * as kyc from './kyc-scenarios.mjs'

const SCENARIOS = [
  ['K01', 'Reject without a usable reason is 400 and changes nothing', kyc.k01],
  ['K02', 'Reject reason reaches the owner and the audit trail only', kyc.k02],
  ['K03', 'Reject from PENDING must not lower an existing tier', kyc.k03],
  ['K04', 'Approval emits exactly one user.kyc_updated and no review event', kyc.k04],
  ['K04-REVIEW', 'user.kyc_reviewed is publishable inside the transaction', kyc.k04Review],
  ['K05', 'Two concurrent reviews change state once and emit one event', kyc.k05],
  ['K06', 'Redelivery dedupes and a conflicting payload is dead-lettered', kyc.k06],
  ['K07', 'Signed document URLs expire and are never cached', kyc.k07],
  ['K08', 'Wrong-endpoint reads are 403 and logs carry no secrets', kyc.k08]
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

export async function runWeek3H14() {
  const args = process.argv.slice(2)
  const unknown = args.filter(arg => !['--keep', '--strict', '--no-build'].includes(arg))
  if (unknown.length) {
    console.error('Usage: node tests/acceptance/week3/phase-week3-h14.mjs [--keep] [--strict] [--no-build]')
    process.exit(1)
  }

  const ctx = await prepare()
  ctx.phase = 'week3-h14'
  ctx.title = '# Week 3 H14 KYC acceptance'
  ctx.requests ??= []

  const recorder = createRecorder(ctx)
  const state = { admin: null, other: null, startedAt: null }
  let started = false

  console.log('Week 3 H14 project: ' + ctx.project)
  console.log('Evidence: ' + ctx.directory)

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
      const seeded = await recorder.check({ id: 'SEED', scenario: 'Create the ADMIN reviewer and a second USER principal' },
        async () => {
          await warmGateway(ctx)
          state.admin = await account(ctx, 'h14-admin', undefined, 'ADMIN')
          state.other = await account(ctx, 'h14-other')
          // K08 scopes the log scan to this run, so it must be captured after the
          // stack is up and before any scenario writes to the service logs.
          state.startedAt = new Date().toISOString()
          return { notes: 'ADMIN + second USER ready; log scan starts at ' + state.startedAt }
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runWeek3H14()
