// One command, fresh Compose volumes, real HTTP/DB/broker/storage and explicit gaps.
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepare, command, docker, sql, root, pause } from './week2/runtime.mjs'
import { seed } from './seed.mjs'
import { s11, s12, s13, k1, infrastructure, conservation, Blocked, pending } from './week2/scenarios.mjs'
import { phase5Scenarios } from './week2/phase5-scenarios.mjs'

export async function runAcceptance(phase = 4) {
const args = process.argv.slice(2)
if (args.some(arg => !['--keep', '--strict'].includes(arg))) {
  console.error('Usage: node tests/acceptance/phase4.mjs [--keep] [--strict]')
  process.exit(1)
}
const ctx = await prepare()
ctx.phase = phase
const results = []
let accounts
console.log('Acceptance project: ' + ctx.project)
console.log('Evidence: ' + ctx.directory)
async function check(id, label, fn, owner) {
  const started = Date.now()
  try {
    await fn()
    results.push({ id, label, owner, status: 'PASS', durationMs: Date.now() - started })
    console.log('PASS ' + id + ': ' + label)
    return true
  } catch (error) {
    // Never serialize child-process errors/stdout or response bodies containing credentials.
    const status = error instanceof Blocked ? 'BLOCKED' : 'FAIL'
    const reason = error instanceof Blocked ? error.message : (error.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : 'Execution error; inspect the local run logs')
    results.push({ id, label, owner, status, reason, durationMs: Date.now() - started })
    console.log(status + ' ' + id + ': ' + reason)
    return false
  }
}
async function regression(id, service, files) {
  const cwd = resolve(root, 'services', service + '-service')
  await command(ctx, id + '-' + service, process.execPath,
    ['--import', 'tsx', '--test', '--test-concurrency=1', ...files.map(file => 'tests/' + file + '.test.ts')],
    { cwd, env: { ...ctx.env, FINVAULT_ACCEPTANCE_CONFIG: resolve(ctx.directory, 'regression.json'),
      S3_PUBLIC_ENDPOINT: ctx.config.S3_PUBLIC_ENDPOINT } })
}
try {
  await check('B2', 'Secret generation, file loading and source fallback regression', async () => {
    await command(ctx, 'b2', process.execPath, ['--test', 'tests/deployment/init-secrets.test.cjs',
      'packages/finvault-internal-auth/tests/secrets.test.cjs', 'tests/deployment/secret-policy.test.cjs'])
    await command(ctx, 'transaction-keys', process.execPath, ['--test', 'tests/deployment/transaction-keys.test.cjs'])
  })
  if (phase === 5) await check('WALLET-TIMEZONE', 'Wallet day/month boundaries use Vietnam time', () =>
    command(ctx, 'wallet-timezone', process.execPath, ['--import', 'tsx', '--test', 'tests/timezone.test.ts'],
      { cwd: resolve(root, 'services/wallet-service') }))
  const started = await check('COMPOSE', 'Build and start a fresh isolated stack', () =>
    command(ctx, 'compose-up', 'docker', [...ctx.composeArgs, 'up', '-d', '--build',
      '--wait', '--wait-timeout', '240']))
  if (started) {
    await check('B6-7', 'Compose, workers, broker, storage and API health', () => infrastructure(ctx))
    const seeded = await check('SEED', 'Demo accounts, KYC tiers, double-entry funding', async () => { accounts = await seed(ctx) })
    if (seeded) {
      const scenarios = phase === 5 ? phase5Scenarios : [
        ...[['S11', 'Approve/reject, audit and confirmed ordered events', s11],
        ['S12', 'Private two-sided documents, authorization, audit and real URL expiry', s12],
        ['S13', 'Exact masked lookup, uniform 404 and request 11 limited', s13],
        ['K1', 'KYC upgrade through tier-aware P2P transfer', k1]].map(([id, label, fn]) => [id, 'Huu', label, fn])]
      for (const [id, owner, label, fn] of scenarios) {
        // Keep each scenario (especially S13's 11 calls) inside one Gateway window.
        const recent = (ctx.requestTimes || []).filter(time => Date.now() - time < 61000)
        if (recent.length > 80) await pause(Math.max(0, recent[0] + 61000 - Date.now()))
        await check(id, label, () => fn(ctx, accounts), owner)
      }
    } else for (const id of ['S11','S12','S13','K1'])
      results.push({ id, status: 'BLOCKED', reason: 'Seed failed' })
    await check('CONSERVATION', 'checkSystemConservation actual balance = 0', () => conservation(ctx))
    const migrated = await check('REGRESSION-DB', 'Migrate separate regression schemas', async () => {
      // Queue names are fixed in the services: a separate exchange alone is not
      // enough to prevent the live app consumer from taking regression messages.
      docker(ctx, 'exec', '-T', 'rabbitmq', 'rabbitmqctl', 'add_vhost', 'acceptance-regression')
      docker(ctx, 'exec', '-T', 'rabbitmq', 'rabbitmqctl', 'set_permissions', '-p',
        'acceptance-regression', ctx.config.RABBITMQ_USER, '.*', '.*', '.*')
      sql(ctx, 'postgres', 'CREATE DATABASE finvault_test')
      for (const service of ['user', 'merchant']) {
        await command(ctx, 'migrate-' + service, process.execPath, ['tests/migrate.cjs'], {
          cwd: resolve(root, 'services', service + '-service'),
          env: { ...ctx.env, FINVAULT_ACCEPTANCE_CONFIG: resolve(ctx.directory, 'regression.json') }
        })
      }
    })
    if (migrated) {
      if (phase === 5) await check('AUTH-REGRESSION', 'Auth security, Gateway PIN aliases and independent rate limits',
        () => regression('auth-regression', 'auth', ['security', 'gateway', 'rateLimiter']))
      await check('B6-1', 'H1: auth negative cases and internal callers', async () => {
        await regression('b6-1', 'user', ['security', 'gateway'])
        await regression('b6-1', 'merchant', ['security'])
      })
      await check('B6-2', 'H2: Inbox replay, rollback, retry, DLQ and restart', () => regression('b6-2', 'user', ['integration/broker', 'integration/profile']))
      await check('B6-3', 'H3: tier/Outbox atomicity, no-op and concurrency', () => regression('b6-3', 'user', ['integration/tier', 'integration/phase2']))
      await check('B6-4', 'H4: cleanup dry-run, orphan scan and reference protection', () => regression('b6-4', 'user', ['cleanup', 'integration/storage']))
      await check('B6-5', 'H5: Merchant ownership and transactional profile Outbox', () => regression('b6-5', 'merchant', ['integration/merchant']))
      await check('B6-6', 'H6: OpenAPI and User/Merchant response contracts', async () => {
        await regression('b6-6', 'user', ['me', 'contracts', 'user', 'integration/lookup'])
        await regression('b6-6', 'merchant', ['my-merchant', 'merchant'])
      })
    } else for (let i = 1; i <= 6; i++) results.push({ id: 'B6-' + i, status: 'BLOCKED', reason: 'Regression schema migration failed' })
  }
} finally {
  for (const id of ['SEED', 'S11', 'S12', 'S13', 'K1', 'CONSERVATION', ...Array.from({ length: 7 }, (_, i) => 'B6-' + (i + 1))])
    if (!results.some(row => row.id === id)) results.push({ id, status: 'BLOCKED', reason: 'An earlier infrastructure prerequisite failed' })
  results.push({ id: 'B6-8', status: 'MANUAL_PENDING', reason: 'Week-1 plan section 8.2: checkpoint/demo evidence and Khoa PR review require human confirmation' })
  if (phase === 4) for (const [id, owner, reason] of pending) results.push({ id, owner, status: 'NOT_IMPLEMENTED', reason })
  else for (const [id, owner, label] of phase5Scenarios)
    if (!results.some(row => row.id === id)) results.push({ id, owner, label, status: 'BLOCKED', reason: 'Earlier infrastructure/seed prerequisite failed' })
  results.push({ id: 'H9', status: 'DEFERRED', reason: 'Should deferred while K1/Wallet-Payment dependencies remain; merchant.status_updated is preserved and seed verifies publication' })
  if (phase === 5) results.push({ id: 'H10', status: 'DEFERRED', reason: 'Merchant portal depends on deferred H9; Phase 5 is frozen for new features' })
  if (!args.includes('--keep')) await check('STOP', 'Stop this acceptance project; retain evidence and volumes', () =>
    command(ctx, 'compose-stop', 'docker', [...ctx.composeArgs, 'stop']))
  const report = { phase, project: ctx.project, completedAt: new Date().toISOString(),
    automatedAcceptanceComplete: results.filter(row => !['B6-8', 'H9', 'H10'].includes(row.id)).every(row => row.status === 'PASS'),
    acceptanceComplete: results.filter(row => !['H9', 'H10'].includes(row.id)).every(row => row.status === 'PASS'),
    results, requests: ctx.requests }
  writeFileSync(resolve(ctx.directory, 'result.json'), JSON.stringify(report, null, 2))
  if (phase === 5) {
    const issues = results.filter(row => ['FAIL', 'BLOCKED'].includes(row.status))
    writeFileSync(resolve(ctx.directory, 'issues.md'), '# Phase 5 — unresolved acceptance cases\n\n' +
      'Local issue drafts; no external tracker or team messages were submitted.\n\n' +
      issues.map(row => '## ' + row.id + ' — ' + (row.label || row.id) + '\n\n' +
        '- Owner: ' + (row.owner || 'Huu / infrastructure') + '\n- Status: ' + row.status +
        '\n- Evidence: ' + row.reason + '\n- Reproduce: `rtk proxy node tests/acceptance/phase5.mjs`\n' +
        '- Acceptance: this scenario must PASS in the same fresh Compose run.\n').join('\n'))
  }
  console.log('Report: ' + resolve(ctx.directory, 'result.json'))
  console.log('Summary: ' + ['PASS','FAIL','BLOCKED','MANUAL_PENDING','NOT_IMPLEMENTED','DEFERRED']
    .map(status => status + '=' + results.filter(row => row.status === status).length).join(', '))
  // A blocked mandatory Phase-4 scenario is never a green exit.
  process.exitCode = results.some(row => ['FAIL','BLOCKED'].includes(row.status)) ||
    (args.includes('--strict') && !report.acceptanceComplete) ? 1 : 0
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runAcceptance()

