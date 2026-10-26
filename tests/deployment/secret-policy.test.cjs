const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, mkdtempSync, writeFileSync, readdirSync, unlinkSync, rmdirSync } = require('node:fs')
const { resolve, join, dirname, basename } = require('node:path')
const { tmpdir } = require('node:os')
const { randomBytes } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const root = resolve(__dirname, '../..')

test('runtime sources and main Compose have no legacy default credentials', () => {
  const files = []
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(ts|js|mjs|cjs)$/.test(path)) files.push(path)
    }
  }
  walk(join(root, 'gateway/src'))
  for (const service of readdirSync(join(root, 'services'))) walk(join(root, 'services', service, 'src'))
  for (const file of files) assert.equal(
    /default_internal_secret_key_123456|postgres:\/\/postgres:postgres|-----BEGIN (?:EC |RSA )?PRIVATE KEY-----|process\.env\.(?:INTERNAL_KEY|ACCESS_TOKEN_SECRET)\s*(?:\|\||\?\?)\s*['"][^'"]+['"]/.test(readFileSync(file, 'utf8')), false, file)
  assert.doesNotMatch(readFileSync(join(root, 'docker-compose.yml'), 'utf8'), /POSTGRES_PASSWORD:-|POSTGRES_PASSWORD_URLENCODED:-/)
})

test('Payment WalletClient sends the file secret and fails before fetching without a key', t => {
  const cwd = join(root, 'services/payment-service')
  const directory = mkdtempSync(join(tmpdir(), 'finvault-payment-secret-'))
  const file = join(directory, 'key')
  t.after(() => {
    assert.equal(dirname(directory), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('finvault-payment-secret-'))
    unlinkSync(file)
    rmdirSync(directory)
  })
  const secret = randomBytes(32).toString('hex')
  writeFileSync(file, secret, { mode: 0o600 })
  const env = { ...process.env, DOTENV_CONFIG_PATH: join(directory, 'absent.env'), INTERNAL_KEY_FILE: file, INTERNAL_KEY: 'ignored-direct-value' }
  const script = "const assert=require('node:assert/strict');const fs=require('node:fs');const {WalletClient}=require('./src/clients/wallet.client');let calls=0;global.fetch=async(u,o)=>{calls++;assert.equal(o.headers['x-internal-key'],fs.readFileSync(process.env.INTERNAL_KEY_FILE,'utf8'));return {ok:true,json:async()=>({data:{}})}};new WalletClient().createHold('fixture','1','ref','date').then(()=>assert.equal(calls,1)).catch(()=>process.exit(1))"
  const run = extra => spawnSync(process.execPath, ['--import', 'tsx', '-e', script], { cwd, env: extra, encoding: 'utf8', windowsHide: true })
  assert.equal(run(env).status, 0, 'WalletClient must use the configured secret file')
  delete env.INTERNAL_KEY_FILE
  delete env.INTERNAL_KEY
  const missing = run(env)
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /Missing required environment variable: INTERNAL_KEY/)
  env.INTERNAL_KEY_FILE = join(directory, 'absent-key')
  env.INTERNAL_KEY = secret
  const unreadable = run(env)
  assert.notEqual(unreadable.status, 0)
  assert.match(unreadable.stderr, /Cannot read required secret/)
})
