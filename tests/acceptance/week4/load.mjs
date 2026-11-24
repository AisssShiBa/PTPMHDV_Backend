import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { prepare, command, hostReady, call, sql, root, until } from '../week2/runtime.mjs'
import { setupPin } from '../week2/p2p-scenarios.mjs'

const keep = process.argv.includes('--keep')
const ownsProject = process.argv.includes('--fresh')
assert.ok(process.argv.slice(2).every(arg => ['--fresh', '--keep'].includes(arg)), 'Expected --fresh and/or --keep')
let ctx
if (ownsProject) {
  assert.ok(!process.env.LIVE_ACCEPTANCE_RUN_FILE, 'Do not combine --fresh and LIVE_ACCEPTANCE_RUN_FILE')
  execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'pipe', timeout: 30000 })
  ctx = await prepare()
} else {
  assert.ok(process.env.LIVE_ACCEPTANCE_RUN_FILE, 'Use --fresh or provide LIVE_ACCEPTANCE_RUN_FILE')
  const file = resolve(process.env.LIVE_ACCEPTANCE_RUN_FILE)
  const run = JSON.parse(readFileSync(file, 'utf8'))
  assert.match(run.project ?? '', /^finvault-acceptance-[0-9a-f]{12}$/)
  assert.equal(dirname(file), resolve(root, '.cache/acceptance-week2', run.project))
  const config = parseEnv(readFileSync(resolve(dirname(file), '.env'), 'utf8'))
  assert.equal(new URL(run.gateway).origin, 'http://127.0.0.1:' + config.GATEWAY_PORT)
  ctx = { project: run.project, directory: dirname(file), config, base: run.gateway,
    env: { ...process.env, ...config }, requests: [], composeArgs: ['compose', '--project-directory', root,
      '--env-file', resolve(dirname(file), '.env'), '-p', run.project, '-f', resolve(root, 'docker-compose.yml'),
      '-f', resolve(dirname(file), 'compose.json')] }
}
const resultFile = resolve(ctx.directory, 'load-result.json')
const save = value => writeFileSync(resultFile, JSON.stringify({ project: ctx.project,
  testedAt: new Date().toISOString(), ...value }, null, 2))
if (existsSync(resultFile)) writeFileSync(resolve(ctx.directory, 'load-result-previous.json'), readFileSync(resultFile))
save({ result: 'RUNNING' })
console.log('Load test isolated project: ' + ctx.project + '\nEvidence: ' + ctx.directory)
try {
  if (ownsProject) {
    await command(ctx, 'load-compose-up', 'docker', [...ctx.composeArgs, 'up', '-d', '--wait', '--wait-timeout', '480'])
    await hostReady(ctx)
  }
  // Fixture preparation is an administrative seed, outside the measured path.
  // Use the real Auth application service (bcrypt, sessions and signup outbox),
  // not a hand-signed JWT or a relaxation of the signup 30/15min HTTP quota.
  const principals = Array.from({ length: 52 }, (_, i) => ({
    username: 'load_' + randomUUID().replaceAll('-', ''), email: 'load_' + randomUUID() + '@example.test',
    password: 'Synthetic-' + randomUUID(), firstName: 'Load', lastName: String(i),
  }))
  const seedCode = `const fs=require('fs');const {AuthService}=require('./src/services/authService');const {prisma}=require('./src/config/prisma');(async()=>{const rows=JSON.parse(fs.readFileSync(0,'utf8'));const result=[];for(let i=0;i<rows.length;i++){const r=rows[i];const created=await AuthService.signUp(r);if(i===0)await prisma.user.update({where:{id:created.userId},data:{role:'ADMIN'}});const session=await AuthService.signIn(r);result.push({id:created.userId,token:session.accessToken});}process.stdout.write(JSON.stringify(result));await prisma.$disconnect()})().catch(()=>{process.stderr.write('Fixture seed failed');process.exit(1)})`
  const seeded = JSON.parse(execFileSync('docker', [...ctx.composeArgs, 'exec', '-T', 'auth-service',
    'node', '--import', 'tsx', '-e', seedCode], { input: JSON.stringify(principals), encoding: 'utf8', timeout: 120000 }))
  assert.equal(seeded.length, 52)
  const [admin, receiver] = seeded
  const senders = []
  for (let i = 0; i < 50; i++) {
    const sender = seeded[i + 2]
    await until(async () => (await call(ctx, '/wallets/' + sender.id + '/balance',
      { token: sender.token, expected: null })).httpStatus === 200, 'Seeded Wallet provisioning')
    await setupPin(ctx, sender)
    await call(ctx, '/wallets/' + sender.id + '/credit', { method: 'POST', token: admin.token,
      body: { amount: '100000', referenceId: randomUUID(), transferType: 'TOPUP' } })
    assert.equal(sql(ctx, 'wallet_service', `SELECT balance::numeric(20,2)::text FROM "Wallet" WHERE "userId"='${sender.id}' AND "ownerType"='USER'`), '100000.00', 'Load fixture must be funded before measurement')
    senders.push({ id: sender.id, token: sender.token })
    if ((i + 1) % 10 === 0) console.log('Prepared ' + (i + 1) + '/50 users; Auth service seed, real PIN and balanced credit')
  }
  // Setup shares the same host IP. Wait a whole real rate-limit window;
  // never flush Redis, forge forwarded IPs or change the Gateway policy.
  console.log('Waiting 61 seconds for setup rate-limit window')
  await delay(31000); console.log('30 seconds until load'); await delay(30000)
  const loadDirectory = resolve(ctx.directory, 'load-private-' + randomUUID().slice(0, 8))
  mkdirSync(loadDirectory, { recursive: true, mode: 0o700 })
  const fixtureFile = resolve(loadDirectory, 'load-fixture.json')
  writeFileSync(fixtureFile, JSON.stringify({ project: ctx.project, base: 'http://gateway:3000/api',
    receiverId: receiver.id, pin: '741852', senders }), { mode: 0o600 })
  const before = sql(ctx, 'wallet_service', 'SELECT COALESCE(sum(balance),0)::text FROM "Wallet"')
  const image = 'grafana/k6:latest'
  await command(ctx, 'load-k6-pull', 'docker', ['pull', image])
  const digest = execFileSync('docker', ['image', 'inspect', image, '--format', '{{index .RepoDigests 0}}'], { encoding: 'utf8' }).trim()
  assert.match(digest, /^grafana\/k6@sha256:[a-f0-9]{64}$/)
  const script = fileURLToPath(new URL('./load.k6.js', import.meta.url))
  let executionError
  try {
    await command(ctx, 'load-k6', 'docker', ['run', '--rm', '--name', ctx.project + '-k6',
      '--network', ctx.project + '_public_net', '--user', '0',
      '--mount', 'type=bind,source=' + loadDirectory + ',target=/private',
      '--mount', 'type=bind,source=' + script + ',target=/scripts/load.js,readonly',
      digest, 'run', '--quiet', '/scripts/load.js'])
  } catch (error) { executionError = error }
  const summaryFile = resolve(loadDirectory, 'load-summary.json')
  assert.ok(existsSync(summaryFile), 'k6 did not produce a summary; inspect load-k6.log')
  const summary = JSON.parse(readFileSync(summaryFile, 'utf8'))
  save({ result: 'RUNNING', image: digest, workload: summary.workload, metrics: summary.metrics,
    summaryPath: summaryFile })
  const ids = senders.map(u => "'" + u.id + "'").join(',')
  const successful = BigInt(sql(ctx, 'payment_service', `SELECT count(*) FROM "Payment" WHERE "userId" IN (${ids}) AND status='SUCCESS'`))
  const ledger = JSON.parse(sql(ctx, 'wallet_service', `SELECT json_build_object('receiver',balance::text,'held',"heldBalance"::text) FROM "Wallet" WHERE "userId"='${receiver.id}' AND "ownerType"='USER'`))
  const money = value => { assert.match(value, /^-?\d+(?:\.00)?$/); return BigInt(value.split('.')[0]) }
  assert.equal(money(ledger.receiver), successful * 1000n, 'Receiver balance must match actual successful payments')
  assert.equal(money(ledger.held), 0n)
  assert.equal(sql(ctx, 'wallet_service', 'SELECT COALESCE(sum(balance),0)::text FROM "Wallet"'), before, 'Conservation changed')
  assert.equal(sql(ctx, 'wallet_service', `SELECT count(*) FROM "Wallet" WHERE "userId" IN (${ids}) AND "heldBalance"<>0`), '0', 'Pending holds remain')
  const senderRows = JSON.parse(sql(ctx, 'wallet_service', `SELECT json_agg(row_to_json(s)) FROM (SELECT w."userId",w.balance::text AS balance,count(e.id) FILTER (WHERE e.direction='DEBIT')::text AS debits FROM "Wallet" w LEFT JOIN "LedgerEntry" e ON e."walletId"=w.id WHERE w."userId" IN (${ids}) AND w."ownerType"='USER' GROUP BY w.id) s`))
  assert.equal(senderRows.length, 50)
  for (const row of senderRows) assert.equal(money(row.balance), 100000n - BigInt(row.debits) * 1000n, 'Sender money/ledger mismatch')
  assert.equal(BigInt(sql(ctx, 'wallet_service', `SELECT count(*) FROM "LedgerEntry" e JOIN "Wallet" w ON w.id=e."walletId" WHERE w."userId"='${receiver.id}' AND e.direction='CREDIT'`)), successful)
  assert.equal(BigInt(Math.round(summary.metrics.transfers_completed?.values.count ?? 0)), successful, 'k6 and DB success counts differ')
  const audits = { completed: successful.toString(), receiverBalance: ledger.receiver, systemBalanceUnchanged: true, pendingSenderHolds: '0' }
  save({ result: executionError ? 'FAIL' : 'PASS', image: digest, workload: summary.workload,
    metrics: summary.metrics, audits, note: 'Auth application-service seed outside timed path. Load uses real Gateway checkout/PIN/confirm with unchanged limits; p95 is not maximum throughput capacity.' })
  if (executionError) throw executionError
  console.log('PASS 50 VU / 5 minutes; money invariants verified; see load-result.json')
} catch (error) {
  const current = JSON.parse(readFileSync(resultFile, 'utf8'))
  if (current.result === 'RUNNING') save({ ...current, result: 'FAIL', reason: error.message })
  throw error
} finally {
  if (ownsProject && !keep) await command(ctx, 'load-cleanup', 'docker', [...ctx.composeArgs, 'down', '--volumes', '--remove-orphans'])
}
