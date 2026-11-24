// K12 rollback acceptance operates only on a clone in an explicit isolated Compose project.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
export async function runRollbackK12() {
  assert.ok(process.env.LIVE_ACCEPTANCE_RUN_FILE, 'Set LIVE_ACCEPTANCE_RUN_FILE to an isolated acceptance run.json')
  const runFile = resolve(process.env.LIVE_ACCEPTANCE_RUN_FILE)
  const run = JSON.parse(readFileSync(runFile, 'utf8'))
  assert.match(run.project ?? '', /^finvault-acceptance-[0-9a-f]{12}$/)
  const directory = resolve(root, '.cache/acceptance-week2', run.project)
  assert.equal(dirname(runFile), directory)
  const container = run.project + '-postgres-1'
  const clone = 'wallet_k12_' + randomUUID().replaceAll('-', '').slice(0, 12)
  assert.match(clone, /^wallet_k12_[0-9a-f]{12}$/)
  const execute = (database, statement) => execFileSync('docker', ['exec', '-i', container,
    'psql', '-U', 'postgres', '-d', database, '-At', '-v', 'ON_ERROR_STOP=1', '-c', statement],
    { encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  const snapshot = database => JSON.parse(execute(database, `SELECT json_build_object(
    'wallets',(SELECT COALESCE(md5(string_agg((to_jsonb(w)-'systemCode')::text,',' ORDER BY id)),'empty') FROM "Wallet" w),
    'ledger',(SELECT COALESCE(md5(string_agg(to_jsonb(e)::text,',' ORDER BY id)),'empty') FROM "LedgerEntry" e),
    'walletCount',(SELECT count(*) FROM "Wallet"), 'ledgerCount',(SELECT count(*) FROM "LedgerEntry"),
    'totalBalance',(SELECT COALESCE(sum(balance),0)::text FROM "Wallet"))`))
  const labels = database => execute(database, `SELECT string_agg(enumlabel,',' ORDER BY enumsortorder) FROM pg_enum JOIN pg_type ON pg_enum.enumtypid=pg_type.oid WHERE typname='SystemWalletCode'`)
  const reportFile = resolve(directory, 'k12-rollback-result.json')
  const checks = []
  let created = false
  try {
    const originalLabels = labels('wallet_service')
    const dump = execFileSync('docker', ['exec', container, 'pg_dump', '-U', 'postgres', '--no-owner', '--no-acl', 'wallet_service'],
      { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
    execute('postgres', `CREATE DATABASE "${clone}"`)
    created = true
    execFileSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', clone, '-q', '-v', 'ON_ERROR_STOP=1'],
      { input: dump, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
    const before = snapshot(clone)
    assert.match(before.totalBalance, /^0(?:\.0+)?$/, 'Source fixture must conserve system balance')
    const down = readFileSync(resolve(root, 'scripts/rollback/down_k12_system_wallet_codes.sql'), 'utf8')
    execute(clone, down)
    const downLabels = labels(clone).split(',')
    assert.ok(downLabels.includes('TOPUP_POOL') && downLabels.includes('MAIN'))
    assert.ok(!downLabels.includes('CLEARING_TOPUP') && !downLabels.includes('SETTLEMENT'))
    assert.deepEqual(snapshot(clone), before)
    checks.push('DOWN: legacy enum labels restored; wallet/held/ledger checksums, row counts and balances unchanged')
    const up = readFileSync(resolve(root, 'services/wallet-service/prisma/migrations/20261104103000_rename_system_wallet_codes/migration.sql'), 'utf8')
    execute(clone, up)
    assert.equal(labels(clone), originalLabels)
    assert.deepEqual(snapshot(clone), before)
    assert.equal(labels('wallet_service'), originalLabels)
    checks.push('UP: current labels restored; original database enum untouched; all financial checksums preserved')
    const result = { passed: true, result: 'PASS', project: run.project, testedAt: new Date().toISOString(), checks, snapshot: before }
    writeFileSync(reportFile, JSON.stringify(result, null, 2))
    return { ...result, logFile: reportFile }
  } catch (error) {
    writeFileSync(reportFile, JSON.stringify({ result: 'FAIL', project: run.project, checks, error: error.message.split('\n')[0] }, null, 2))
    throw error
  } finally {
    if (created) execute('postgres', `DROP DATABASE "${clone}" WITH (FORCE)`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRollbackK12().then(result => console.log('PASS: K12 clone DOWN/UP; evidence: ' + result.logFile))
    .catch(error => { console.error(error.message.split('\n')[0]); process.exitCode = 1 })
}
