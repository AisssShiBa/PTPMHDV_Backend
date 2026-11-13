// Week 4 (N20) seed: five pending KYC profiles, sample notifications and one
// deliberate wallet drift for A8. Everything goes through the real Gateway APIs
// except the single documented drift UPDATE, which only touches
// "Wallet".balance and never a ledger entry.
//
// Ordering (printed at the end as well):
//   RC1 (reconciliation, isBalanced=true) MUST run BEFORE this seed.
//   A8 (drift anomaly) MUST run AFTER this seed.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { call, docker, sql, until } from '../week2/runtime.mjs'
import {
  DRIFT_AMOUNT,
  DRIFT_CREDIT_AMOUNT,
  DRIFT_SLOT,
  KYC_CREDIT_AMOUNT,
  KYC_SLOTS,
  assertDriftAllowed,
  classifyDrift,
  missingSlots,
  notificationEventId,
  shouldUploadKyc,
  syntheticDocument
} from './seed-lib.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(here, '../../..')
const accountsFile = 'week4-accounts.json'

function requireSafeSqlValue(value) {
  assert.match(String(value), /^[A-Za-z0-9@._-]+$/, 'unsafe SQL literal: ' + value)
  return String(value)
}

function readAccounts(directory) {
  const file = resolve(directory, accountsFile)
  if (!existsSync(file)) return {}
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeAccounts(directory, accounts) {
  writeFileSync(resolve(directory, accountsFile), JSON.stringify(accounts, null, 2), {
    mode: 0o600
  })
}

function authIdByEmail(ctx, email) {
  return sql(
    ctx,
    'auth_service',
    'SELECT id FROM "User" WHERE email = \'' + requireSafeSqlValue(email) + '\''
  )
}

function profileByAuthId(ctx, authId) {
  return sql(
    ctx,
    'user_service',
    'SELECT id || \'|\' || kyc_status::text FROM users WHERE auth_user_id = \'' +
      requireSafeSqlValue(authId) +
      '\''
  )
}

function walletIdByUser(ctx, authId) {
  return sql(
    ctx,
    'wallet_service',
    'SELECT id FROM "Wallet" WHERE "userId" = \'' +
      requireSafeSqlValue(authId) +
      '\' AND "ownerType" = \'USER\''
  )
}

function walletMoney(ctx, walletId) {
  return sql(
    ctx,
    'wallet_service',
    'SELECT balance::bigint::text FROM "Wallet" WHERE id = \'' +
      requireSafeSqlValue(walletId) +
      '\''
  )
}

function ledgerTotal(ctx, walletId) {
  return sql(
    ctx,
    'wallet_service',
    'SELECT ((COALESCE(SUM(CASE WHEN direction = \'CREDIT\' THEN amount ELSE -amount END), 0))::bigint)::text' +
      ' FROM "LedgerEntry" WHERE "walletId" = \'' +
      requireSafeSqlValue(walletId) +
      '\''
  )
}

function pendingKycCount(ctx) {
  return sql(ctx, 'user_service', "SELECT count(*) FROM users WHERE kyc_status = 'PENDING'")
}

async function resolveAdmin(ctx, options) {
  if (options.adminToken) return options.adminToken
  const directory = options.directory ?? ctx.directory
  const file = resolve(directory, 'accounts.json')
  assert.ok(existsSync(file), 'Base seed accounts.json is missing; run the base seed first')
  const accounts = JSON.parse(readFileSync(file, 'utf8'))
  const admin = accounts.admin
  assert.ok(admin?.username && admin?.password, 'Base seed has no admin credentials')
  const login = await call(ctx, '/auth/signin', {
    method: 'POST',
    body: { username: admin.username, password: admin.password }
  })
  assert.ok(login.data?.accessToken, 'Admin signin returned no access token')
  return login.data.accessToken
}

/**
 * Creates the account through the real signup API when it is absent, then
 * returns { authId, profile, token? }. A rerun never re-creates the account and
 * never resets KYC state.
 */
async function ensureAccount(ctx, slot, accounts) {
  const stored = accounts[slot.key]
  let authId = authIdByEmail(ctx, slot.email)
  let created = false

  if (!authId) {
    const password = stored?.password ?? randomBytes(18).toString('hex')
    await call(ctx, '/auth/signup', {
      method: 'POST',
      expected: 201,
      body: {
        username: slot.username,
        email: slot.email,
        password,
        firstName: 'Week4',
        lastName: slot.key
      }
    })
    accounts[slot.key] = { username: slot.username, email: slot.email, password }
    authId = await until(
      () => authIdByEmail(ctx, slot.email),
      'Auth provisioning timed out for ' + slot.email
    )
    created = true
  }

  return { authId, created, stored: accounts[slot.key] }
}

async function ensureKyc(ctx, slot, account, accounts) {
  const existingProfile = profileByAuthId(ctx, account.authId)
  const existingStatus = existingProfile ? existingProfile.split('|')[1] : null
  let uploadedNow = false

  if (!existingProfile || shouldUploadKyc(existingStatus)) {
    assert.ok(
      account.stored?.password,
      'Account ' +
        slot.email +
        ' exists without a stored password and cannot upload KYC; reset the KYC demo account manually'
    )
    const login = await call(ctx, '/auth/signin', {
      method: 'POST',
      body: { username: account.stored.username, password: account.stored.password }
    })
    const token = login.data?.accessToken
    assert.ok(token, 'Signin returned no access token for ' + slot.email)
    await until(async () => {
      const response = await call(ctx, '/users/me', { token, expected: null })
      return response.httpStatus === 200
    }, 'Profile provisioning timed out for ' + slot.email)

    const form = new FormData()
    form.set('idNumber', slot.idNumber)
    form.set(
      'front',
      new Blob([await syntheticDocument(slot, 'front')], { type: 'image/png' }),
      'week4-' + slot.key + '-front.png'
    )
    form.set(
      'back',
      new Blob([await syntheticDocument(slot, 'back')], { type: 'image/png' }),
      'week4-' + slot.key + '-back.png'
    )
    await call(ctx, '/users/kyc/documents', { method: 'POST', token, body: form, expected: 202 })
    accounts[slot.key].kycUploadedAt = new Date().toISOString()
    uploadedNow = true
  }

  const profile = profileByAuthId(ctx, account.authId)
  assert.ok(profile, 'Profile row is missing for ' + slot.email)
  const [profileId, status] = profile.split('|')
  if (uploadedNow) {
    assert.equal(
      status,
      'PENDING',
      'Newly uploaded KYC of ' + slot.email + ' must be PENDING, got ' + status
    )
  }
  assert.ok(
    ['NONE', 'PENDING', 'APPROVED', 'REJECTED'].includes(status),
    'Unexpected KYC status for ' + slot.email + ': ' + status
  )
  return { profileId, status, uploadedNow }
}

async function creditOnce(ctx, authId, amount, referenceId, adminToken) {
  await call(ctx, '/wallets/' + authId + '/credit', {
    method: 'POST',
    token: adminToken,
    body: { amount, referenceId, transferType: 'TOPUP' }
  })
}

/**
 * internalAuth route of notification-service; the port is not published to the
 * host, so the call runs inside the notification-service container. The key is
 * read from the mounted secret and never printed.
 */
function notifyInternal(ctx, payload) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  const script =
    "const fs=require('fs');" +
    "fetch('http://127.0.0.1:3006/api/notifications',{method:'POST',headers:{'content-type':'application/json','x-internal-key':fs.readFileSync('/run/secrets/internal_key','utf8').trim()},body:Buffer.from('" +
    encoded +
    "','base64').toString()})" +
    ".then(async r=>{const t=await r.text();console.log(r.status);console.log(t)})" +
    '.catch(e=>{console.error(e.message);process.exit(1)})'
  const output = docker(ctx, 'exec', '-T', 'notification-service', 'node', '-e', script)
  const [statusLine, ...rest] = output.split(/\r?\n/)
  const status = Number(statusLine)
  assert.ok([200, 201].includes(status), 'Notification seed failed with HTTP ' + statusLine)
  return JSON.parse(rest.join('\n') || '{}')
}

async function seedKycProfile(ctx, slot, adminToken, accounts) {
  const account = await ensureAccount(ctx, slot, accounts)
  const kyc = await ensureKyc(ctx, slot, account, accounts)

  await creditOnce(
    ctx,
    account.authId,
    KYC_CREDIT_AMOUNT,
    'week4-kyc-' + slot.key + '-credit',
    adminToken
  )
  const walletId = walletIdByUser(ctx, account.authId)
  assert.ok(walletId, 'Wallet is missing for ' + slot.email)
  assert.equal(walletMoney(ctx, walletId), KYC_CREDIT_AMOUNT)

  const notification = notifyInternal(ctx, {
    eventId: notificationEventId(slot.key),
    userId: account.authId,
    type: 'WALLET_CREDITED',
    message: 'Ví demo Tuần 4 đã được nạp ' + KYC_CREDIT_AMOUNT + ' ₫ để kiểm thử.'
  })

  return {
    key: slot.key,
    email: slot.email,
    authId: account.authId,
    profileId: kyc.profileId,
    kycStatus: kyc.status,
    walletId,
    balance: walletMoney(ctx, walletId),
    createdNow: account.created,
    uploadedNow: kyc.uploadedNow,
    notificationCreated: notification.success === true && notification.duplicate !== true,
    notificationDuplicate: notification.duplicate === true
  }
}

async function seedDrift(ctx, adminToken, env, accounts) {
  assertDriftAllowed(env)
  const account = await ensureAccount(ctx, DRIFT_SLOT, accounts)
  await creditOnce(
    ctx,
    account.authId,
    DRIFT_CREDIT_AMOUNT,
    'week4-drift-credit',
    adminToken
  )
  const walletId = walletIdByUser(ctx, account.authId)
  assert.ok(walletId, 'Drift wallet is missing')

  const balanceBefore = walletMoney(ctx, walletId)
  const ledgerBefore = ledgerTotal(ctx, walletId)
  const decision = classifyDrift({ balance: balanceBefore, ledgerTotal: ledgerBefore })
  if (decision === 'apply') {
    sql(
      ctx,
      'wallet_service',
      'UPDATE "Wallet" SET balance = balance + ' +
        BigInt(DRIFT_AMOUNT) +
        ' WHERE id = \'' +
        requireSafeSqlValue(walletId) +
        '\''
    )
  }

  const balanceAfter = walletMoney(ctx, walletId)
  const ledgerAfter = ledgerTotal(ctx, walletId)
  assert.equal(
    classifyDrift({ balance: balanceAfter, ledgerTotal: ledgerAfter }),
    'skip',
    'Drift wallet is not in the expected state'
  )
  assert.equal(
    (BigInt(balanceAfter) - BigInt(ledgerAfter)).toString(),
    DRIFT_AMOUNT,
    'Drift wallet delta must be exactly ' + DRIFT_AMOUNT
  )

  // No SYSTEM wallet and none of the demo accounts named by the plan may drift.
  assert.notEqual(DRIFT_SLOT.email, 'admin@demo.vn')
  for (const reserved of ['an@demo.vn', 'binh@demo.vn', 'chi@demo.vn', 'highlands@demo.vn']) {
    assert.notEqual(DRIFT_SLOT.email, reserved)
  }

  return {
    key: DRIFT_SLOT.key,
    email: DRIFT_SLOT.email,
    authId: account.authId,
    walletId,
    balance: balanceAfter,
    ledgerTotal: ledgerAfter,
    drift: DRIFT_AMOUNT,
    appliedNow: decision === 'apply'
  }
}

/**
 * @param {object} ctx week2 acceptance runtime context (project, directory,
 *   config, composeArgs, env, base) built by tests/acceptance/week2/runtime.mjs
 * @param {{ adminToken?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export async function seedNguyen(ctx, options = {}) {
  assert.match(ctx.project, /^finvault-acceptance-[0-9a-f]{12}$/)
  const env = options.env ?? process.env
  const adminToken = await resolveAdmin(ctx, options)
  const accounts = readAccounts(ctx.directory)

  const existingEmails = KYC_SLOTS.filter((slot) => authIdByEmail(ctx, slot.email)).map(
    (slot) => slot.email
  )
  const missing = missingSlots(KYC_SLOTS, existingEmails)
  const profiles = []
  for (const slot of KYC_SLOTS) {
    profiles.push(await seedKycProfile(ctx, slot, adminToken, accounts))
    writeAccounts(ctx.directory, accounts)
  }

  const drift = await seedDrift(ctx, adminToken, env, accounts)
  writeAccounts(ctx.directory, accounts)

  const pending = pendingKycCount(ctx)
  if (profiles.every((profile) => profile.uploadedNow)) {
    assert.ok(
      Number(pending) >= KYC_SLOTS.length,
      'Expected at least five PENDING KYC profiles after the first run'
    )
  }

  const totalExcludingDrift = sql(
    ctx,
    'wallet_service',
    'SELECT (COALESCE(SUM(balance), 0)::bigint)::text FROM "Wallet" WHERE id <> \'' +
      requireSafeSqlValue(drift.walletId) +
      '\''
  )
  assert.equal(
    BigInt(totalExcludingDrift),
    0n,
    'Balance conservation excluding the drift wallet must stay 0'
  )

  const summary = {
    project: ctx.project,
    createdAt: new Date().toISOString(),
    kycProfiles: profiles,
    missingBeforeRun: missing.map((slot) => slot.key),
    pendingKycProfiles: Number(pending),
    driftWallet: drift,
    totalBalanceExcludingDrift: totalExcludingDrift,
    notifications: profiles.map((profile) => ({
      key: profile.key,
      type: 'WALLET_CREDITED',
      eventId: notificationEventId(profile.key),
      created: profile.notificationCreated,
      duplicate: profile.notificationDuplicate
    })),
    ordering: [
      'Run RC1 (reconciliation) BEFORE this seed when isBalanced=true is expected.',
      'Run A8 (balance drift anomaly) AFTER this seed.',
      'Total wallet balance excluding the drift wallet stays 0.'
    ]
  }
  writeFileSync(resolve(ctx.directory, 'week4-seed.json'), JSON.stringify(summary, null, 2))

  console.log('Week 4 seed: ' + KYC_SLOTS.length + ' PENDING KYC profiles, ' +
    profiles.length + ' sample notifications, 1 drift wallet.')
  console.log('KYC profiles: ' + profiles.map((profile) => profile.email + '=' + profile.kycStatus).join(', '))
  console.log('Notifications created now: ' +
    profiles.filter((profile) => profile.notificationCreated).length + ', already present: ' +
    profiles.filter((profile) => profile.notificationDuplicate).length)
  console.log('WARNING: drift wallet ' + drift.walletId + ' (' + drift.email + ') has +' +
    DRIFT_AMOUNT + ' VND not backed by the ledger.')
  console.log('Run RC1 BEFORE this seed and A8 AFTER it. Evidence: ' +
    resolve(ctx.directory, 'week4-seed.json'))
  return summary
}

/**
 * Rebuilds the subset of the week2 context the seed needs, so it can also be
 * invoked against an already-running acceptance project:
 *   node tests/acceptance/week4/seed-nguyen.mjs --project finvault-acceptance-<id>
 */
export function contextFromProject(project) {
  assert.match(project, /^finvault-acceptance-[0-9a-f]{12}$/)
  const directory = resolve(root, '.cache/acceptance-week2', project)
  assert.ok(existsSync(resolve(directory, 'run.json')), 'Unknown acceptance project: ' + project)
  const run = JSON.parse(readFileSync(resolve(directory, 'run.json'), 'utf8'))
  const config = parseEnv(readFileSync(resolve(directory, '.env'), 'utf8'))
  const env = { ...process.env, ...config, COMPOSE_PROJECT_NAME: project, COMPOSE_PARALLEL_LIMIT: '2' }
  for (const key of ['INTERNAL_KEY_FILE', 'ACCESS_TOKEN_SECRET_FILE', 'DATABASE_URL', 'COMPOSE_FILE']) {
    delete env[key]
  }
  const composeArgs = [
    'compose',
    '--project-directory', root,
    '--env-file', resolve(directory, '.env'),
    '-p', project,
    '-f', resolve(root, 'docker-compose.yml'),
    '-f', resolve(directory, 'compose.json')
  ]
  return {
    project,
    directory,
    config,
    env,
    composeArgs,
    base: run.gateway ?? 'http://127.0.0.1:' + config.GATEWAY_PORT,
    requests: []
  }
}

async function main() {
  const args = process.argv.slice(2)
  const projectIndex = args.indexOf('--project')
  const project = projectIndex >= 0 ? args[projectIndex + 1] : undefined
  if (!project) {
    console.error('Usage: node tests/acceptance/week4/seed-nguyen.mjs --project finvault-acceptance-<id>')
    console.error('Run the base seed in that project first so accounts.json exists.')
    process.exit(1)
  }
  const ctx = contextFromProject(project)
  await seedNguyen(ctx)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
