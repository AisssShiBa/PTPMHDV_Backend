// Week 3 / H13 runner: the M01-M08 merchant matrix (outlet, API key, QR HMAC)
// against a fresh isolated Compose project. Every result is answered by the stack
// this run started; no PASS is inferred from the earlier test-database pass.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepare, command, hostReady, pause } from '../week2/runtime.mjs'
import { infrastructure, conservation } from '../week2/scenarios.mjs'
import { createRecorder } from './reporting.mjs'
import * as merchant from './merchant-scenarios.mjs'

const SCENARIOS = [
  ['M01', 'An APPROVED owner creates an outlet; one profile event at the new version', merchant.m01],
  ['M02', 'An unapproved merchant cannot create an outlet, key or QR', merchant.m02],
  ['M03', 'Nested resources are owner-isolated; ADMIN is allowed', merchant.m03],
  ['M04', 'A duplicate outlet code is a safe 409 and does not leak the constraint', merchant.m04],
  ['M05', 'The served QR verifies and a single mutated byte does not', merchant.m05],
  ['M06', 'The API key secret exists only in the creation response; the DB keeps a hash', merchant.m06],
  ['M07', 'Revocation is idempotent and never re-exposes the secret', merchant.m07],
  ['M08', 'Earlier merchants and outbox versions survive the migration', merchant.m08]
]

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

export async function runWeek3H13() {
  const args = process.argv.slice(2)
  const unknown = args.filter(arg => !['--keep', '--strict', '--no-build'].includes(arg))
  if (unknown.length) {
    console.error('Usage: node tests/acceptance/week3/phase-week3-h13.mjs [--keep] [--strict] [--no-build]')
    process.exit(1)
  }

  const ctx = await prepare()
  ctx.phase = 'week3-h13'
  ctx.title = '# Week 3 H13 merchant acceptance'
  ctx.requests ??= []

  const recorder = createRecorder(ctx)
  const state = {}
  let started = false

  console.log('Week 3 H13 project: ' + ctx.project)
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
      await recorder.check({ id: 'SEED', scenario: 'Create an ADMIN and three owners; approve merchants A and B' }, async () => {
        await warmGateway(ctx)
        return merchant.seed(ctx, state)
      })
    }

    if (state.ownerA) {
      for (const [id, scenario, fn] of SCENARIOS) {
        const recent = (ctx.requestTimes || []).filter(time => Date.now() - time < 61000)
        if (recent.length > 80) await pause(Math.max(0, recent[0] + 61000 - Date.now()))
        await recorder.check({ id, scenario }, () => fn(ctx, state))
      }
    }

    await recorder.check({ id: 'CONSERVATION', scenario: 'checkSystemConservation actual = 0 and SUM(Wallet.balance) = 0' },
      () => conservation(ctx))
  }

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runWeek3H13()
