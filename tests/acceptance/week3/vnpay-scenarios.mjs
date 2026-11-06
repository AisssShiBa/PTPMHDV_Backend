import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { call, command, docker, sql, pause } from '../week2/runtime.mjs'
import { Blocked } from './reporting.mjs'

// H11 acceptance matrix (plan section 4.5). Every assertion is answered by the
// isolated stack: real Gateway -> payment-service -> wallet-service -> Postgres.
// The VNPAY checksum is forged here with an independent implementation of the
// canonical PAY algorithm, so the service's own signer is cross-checked rather
// than reused. No real VNPAY sandbox is contacted.

export const TMN = 'SYNTH_TMN_CODE'
const AMOUNT = 100000
const CLEARING_TOPUP = 'CLEARING_TOPUP'

export function signVnpay(params, secret) {
  const sorted = {}
  for (const key of Object.keys(params).sort()) sorted[key] = String(params[key])
  const data = Object.entries(sorted)
    .map(([key, value]) => key + '=' + encodeURIComponent(value).replace(/%20/g, '+'))
    .join('&')
  return createHmac('sha512', secret).update(Buffer.from(data, 'utf-8')).digest('hex')
}

function paidParams({ code, amount = AMOUNT, responseCode = '00', transactionStatus = '00', tmn = TMN, extra = {} }) {
  return {
    vnp_TmnCode: tmn,
    vnp_TxnRef: code,
    vnp_Amount: String(amount * 100),
    vnp_ResponseCode: responseCode,
    vnp_TransactionStatus: transactionStatus,
    vnp_TransactionNo: '14123456',
    vnp_BankCode: 'NCB',
    vnp_PayDate: '20261104120000',
    ...extra,
  }
}

function ipnPath(ctx, params, { secret = ctx.config.VNP_HASH_SECRET, path = '/funding/vnpay/ipn' } = {}) {
  const signed = { ...params, vnp_SecureHash: signVnpay(params, secret) }
  return path + '?' + new URLSearchParams(signed).toString()
}
const sendIpn = (ctx, params, options = {}) =>
  call(ctx, ipnPath(ctx, params, options), { expected: null })

const topupRow = (ctx, id) => JSON.parse(sql(ctx, 'payment_service',
  `SELECT json_build_object('code', code, 'status', status, 'amount', amount::text,
     'walletTransactionId', "walletTransactionId")
   FROM "TopupRequest" WHERE id='${id}'`))
const statusOf = (ctx, id) => sql(ctx, 'payment_service', `SELECT status FROM "TopupRequest" WHERE id='${id}'`)
const ledgerCount = (ctx, referenceId) => Number(sql(ctx, 'wallet_service',
  `SELECT count(*) FROM "LedgerEntry" WHERE "referenceId"='${referenceId}'`))
const userBalance = (ctx, userId) => Number(sql(ctx, 'wallet_service',
  `SELECT balance FROM "Wallet" WHERE "userId"='${userId}' AND "ownerType"='USER'`))
const systemBalance = (ctx, code) => Number(sql(ctx, 'wallet_service',
  `SELECT balance FROM "Wallet" WHERE "systemCode"='${code}'`))
const ledgerShape = (ctx, referenceId) => JSON.parse(sql(ctx, 'wallet_service',
  `SELECT json_build_object('rows', count(*), 'transactions', count(DISTINCT "transactionId"))
   FROM "LedgerEntry" WHERE "referenceId"='${referenceId}'`))
const counterparty = (ctx, referenceId) => sql(ctx, 'wallet_service',
  `SELECT e.direction || ':' || w."systemCode" FROM "LedgerEntry" e
   JOIN "Wallet" w ON w.id = e."walletId"
   WHERE e."referenceId"='${referenceId}' AND w."ownerType"='SYSTEM'`)

async function create(ctx, user, amount = AMOUNT, path = ctx.createPath ?? '/funding/vnpay/create') {
  const created = await call(ctx, path, { method: 'POST', token: user.token, expected: 201, body: { amount } })
  const row = topupRow(ctx, created.data.topupId)
  assert.equal(row.amount, amount.toFixed(2), 'persisted amount must match the request exactly')
  assert.equal(row.status, 'PENDING')
  assert.match(created.data.paymentUrl, /vnp_SecureHash=[0-9a-f]{128}/, 'create must return a signed VNPAY URL')
  return { id: created.data.topupId, code: row.code, paymentUrl: created.data.paymentUrl }
}

async function waitFor(check, message, timeout = 300000, interval = 3000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await pause(interval)
  }
  throw new Error(message)
}

export async function v01(ctx, state) {
  const user = state.user
  const before = userBalance(ctx, user.id)
  const systemBefore = systemBalance(ctx, CLEARING_TOPUP)
  const topup = await create(ctx, user)
  assert.ok(topup.paymentUrl.includes('vnp_TxnRef=' + topup.code))

  const response = await sendIpn(ctx, paidParams({ code: topup.code }))
  assert.equal(response.httpStatus, 200)
  assert.equal(response.RspCode, '00', 'a valid paid IPN must be acknowledged')

  const row = topupRow(ctx, topup.id)
  assert.equal(row.status, 'APPROVED')
  assert.match(String(row.walletTransactionId), /^[0-9a-f-]{36}$/)
  assert.equal(userBalance(ctx, user.id), before + AMOUNT)
  assert.equal(systemBalance(ctx, CLEARING_TOPUP), systemBefore - AMOUNT)
  assert.deepEqual(ledgerShape(ctx, topup.code), { rows: 2, transactions: 1 })
  assert.equal(counterparty(ctx, topup.code), 'DEBIT:' + CLEARING_TOPUP)

  return { httpStatus: response.httpStatus, errorCode: response.RspCode,
    walletReferenceId: topup.code, ledgerInvariant: 'user +100000, CLEARING_TOPUP -100000, one transactionId' }
}

// V02 = A6: a sequential replay is idempotent.
export async function a6(ctx, state) {
  const user = state.user
  const topup = await create(ctx, user)
  const first = await sendIpn(ctx, paidParams({ code: topup.code }))
  assert.equal(first.RspCode, '00')
  const after = userBalance(ctx, user.id)

  const second = await sendIpn(ctx, paidParams({ code: topup.code }))
  assert.equal(second.httpStatus, 200)
  assert.equal(second.RspCode, '02', 'a replay of an approved topup must answer 02')
  assert.equal(userBalance(ctx, user.id), after, 'replay must not credit twice')
  assert.equal(statusOf(ctx, topup.id), 'APPROVED')
  assert.deepEqual(ledgerShape(ctx, topup.code), { rows: 2, transactions: 1 })

  return { httpStatus: second.httpStatus, errorCode: '00 then ' + second.RspCode,
    walletReferenceId: topup.code, ledgerInvariant: 'exactly one credit across two IPNs' }
}

export async function v03(ctx, state) {
  const user = state.user
  const topup = await create(ctx, user)
  const before = userBalance(ctx, user.id)
  const path = ipnPath(ctx, paidParams({ code: topup.code }))
  const replies = await Promise.all(Array.from({ length: 20 }, () => call(ctx, path, { expected: null })))

  assert.ok(replies.every(reply => reply.httpStatus === 200), 'IPN must always answer HTTP 200')
  assert.ok(replies.every(reply => ['00', '02', '99'].includes(reply.RspCode)),
    'only protocol responses are allowed: ' + JSON.stringify(replies.map(reply => reply.RspCode)))
  assert.equal(replies.filter(reply => reply.RspCode === '00').length, 1,
    'exactly one concurrent IPN may acknowledge success')
  assert.equal(statusOf(ctx, topup.id), 'APPROVED')
  assert.equal(userBalance(ctx, user.id), before + AMOUNT)
  assert.deepEqual(ledgerShape(ctx, topup.code), { rows: 2, transactions: 1 })

  return { httpStatus: 200, errorCode: replies.map(reply => reply.RspCode).join(','),
    walletReferenceId: topup.code, ledgerInvariant: '20 concurrent IPNs -> exactly one credit' }
}

export async function v04(ctx, state) {
  const topup = await create(ctx, state.user)
  const params = paidParams({ code: topup.code })
  const forged = { ...params, vnp_SecureHash: 'a'.repeat(128) }
  const response = await call(ctx, '/funding/vnpay/ipn?' + new URLSearchParams(forged).toString(), { expected: null })
  assert.equal(response.httpStatus, 200)
  assert.equal(response.RspCode, '97')
  assert.equal(statusOf(ctx, topup.id), 'PENDING')
  assert.equal(ledgerCount(ctx, topup.code), 0)
  return { httpStatus: response.httpStatus, errorCode: response.RspCode,
    walletReferenceId: topup.code, ledgerInvariant: 'unchanged, zero ledger rows' }
}

export async function v05(ctx, state) {
  const topup = await create(ctx, state.user)
  const response = await sendIpn(ctx, paidParams({ code: topup.code, amount: 99999 }))
  assert.equal(response.httpStatus, 200)
  assert.equal(response.RspCode, '04')
  assert.equal(statusOf(ctx, topup.id), 'PENDING')
  assert.equal(ledgerCount(ctx, topup.code), 0)
  return { httpStatus: response.httpStatus, errorCode: response.RspCode,
    walletReferenceId: topup.code, ledgerInvariant: 'unchanged, zero ledger rows' }
}

export async function v06(ctx, state) {
  const topup = await create(ctx, state.user)
  const response = await sendIpn(ctx, paidParams({ code: topup.code, tmn: 'OTHER_TMN' }))
  assert.equal(response.httpStatus, 200)
  assert.equal(response.RspCode, '97', 'an unknown terminal must be rejected')
  assert.equal(statusOf(ctx, topup.id), 'PENDING')
  assert.equal(ledgerCount(ctx, topup.code), 0)
  return { httpStatus: response.httpStatus, errorCode: response.RspCode,
    walletReferenceId: topup.code, ledgerInvariant: 'unchanged, zero ledger rows' }
}

export async function v07(ctx, state) {
  const response = await sendIpn(ctx, paidParams({ code: 'NAP_UNKNOWN_' + Date.now() }))
  assert.equal(response.httpStatus, 200)
  assert.equal(response.RspCode, '01')
  return { httpStatus: response.httpStatus, errorCode: response.RspCode,
    ledgerInvariant: 'no matching TopupRequest, nothing created' }
}

// V10: alias and legacy routes must resolve to the same row/service.
export async function v10(ctx, state) {
  const user = state.user
  const before = userBalance(ctx, user.id)
  const topup = await create(ctx, user, AMOUNT, '/payments/topups')
  const params = paidParams({ code: topup.code })

  const viaAlias = await sendIpn(ctx, params)
  assert.equal(viaAlias.RspCode, '00')
  const viaLegacy = await sendIpn(ctx, params, { path: '/payments/topups/vnpay/ipn' })
  assert.equal(viaLegacy.RspCode, '02', 'the legacy route must see the alias transaction as already confirmed')

  assert.equal(userBalance(ctx, user.id), before + AMOUNT)
  assert.deepEqual(ledgerShape(ctx, topup.code), { rows: 2, transactions: 1 })
  return { httpStatus: 200, errorCode: '00 via alias, 02 via legacy',
    walletReferenceId: topup.code, ledgerInvariant: 'both routes -> one transaction' }
}

export async function v11(ctx, state) {
  const user = state.user
  const unauth = await call(ctx, '/funding/vnpay/create', { method: 'POST', expected: null, body: { amount: AMOUNT } })
  assert.equal(unauth.httpStatus, 401, 'creating an order without Bearer must be rejected')
  const legacyUnauth = await call(ctx, '/payments/topups', { method: 'POST', expected: null, body: { amount: AMOUNT } })
  assert.equal(legacyUnauth.httpStatus, 401)

  const topup = await create(ctx, user)
  const before = userBalance(ctx, user.id)
  for (const path of ['/funding/vnpay/return', '/payments/topups/vnpay/return']) {
    const response = await call(ctx, ipnPath(ctx, paidParams({ code: topup.code }), { path }), { expected: null })
    assert.equal(response.httpStatus, 200, path + ' must render a result, not fail')
  }
  assert.equal(statusOf(ctx, topup.id), 'PENDING', 'the return URL must never decide payment')
  assert.equal(userBalance(ctx, user.id), before)
  assert.equal(ledgerCount(ctx, topup.code), 0)
  return { httpStatus: unauth.httpStatus, errorCode: unauth.error?.code,
    walletReferenceId: topup.code, ledgerInvariant: 'return URL is read-only' }
}

export async function v12(ctx, state) {
  const user = state.user
  const maximum = await create(ctx, user, 100000000)
  assert.equal(topupRow(ctx, maximum.id).amount, '100000000.00')

  const rejected = []
  // Validation is asserted on the route this run can authenticate to. The alias
  // path is exercised separately by GATEWAY-ALIAS-CREATE, which reports the
  // Gateway whitelist gap rather than masking it as a validation failure.
  const createPath = ctx.createPath ?? '/funding/vnpay/create'
  for (const body of [{ amount: 100000001 }, { amount: 100000.5 }, { amount: 0 }, { amount: -1000 }, { amount: '' }, {}]) {
    const response = await call(ctx, createPath,
      { method: 'POST', token: user.token, expected: null, body })
    assert.equal(response.httpStatus, 400, 'amount must be validated: ' + JSON.stringify(body))
    rejected.push(response.error?.code)
  }

  const pending = await create(ctx, user)
  const base = paidParams({ code: pending.code })
  const duplicated = new URLSearchParams({ ...base, vnp_SecureHash: 'c'.repeat(128) }).toString() +
    '&vnp_TxnRef=' + encodeURIComponent(pending.code)
  const array = await call(ctx, '/funding/vnpay/ipn?' + duplicated, { expected: null })
  assert.equal(array.RspCode, '97', 'duplicated query keys must be rejected')

  const foreign = await sendIpn(ctx, paidParams({ code: pending.code, extra: { userId: 'attacker' } }))
  assert.equal(foreign.RspCode, '97', 'non-VNPAY parameters must be rejected')
  assert.equal(statusOf(ctx, pending.id), 'PENDING')
  assert.equal(ledgerCount(ctx, pending.code), 0)

  return { httpStatus: 400, errorCode: rejected.join(','),
    walletReferenceId: maximum.code, ledgerInvariant: 'max amount persisted exactly; invalid amounts never created' }
}

// Fault injection runs a service module inside its own container. Those
// modules open Prisma and RabbitMQ handles, so the process would never exit on
// its own and docker exec would hang until the transport timeout. Exiting
// explicitly turns the injected script into a bounded, synchronous call.
function inject(ctx, service, body) {
  // Service modules log to stdout while loading (RabbitMQ banner, etc.), so the
  // result is framed by a marker and read from its last occurrence. No escape
  // sequences: the Windows docker shim re-parses the argument, so a "\n" in the
  // source would reach node as a literal newline.
  const script = 'const MARK="__INJECT_RESULT__";' +
    'const done=(value)=>{process.stdout.write(MARK+JSON.stringify(value),()=>process.exit(0))};' +
    'const fail=(error)=>{process.stderr.write(String(error&&error.message||error),()=>process.exit(1))};' +
    'Promise.resolve().then(async()=>{' + body + '}).then(done).catch(fail)'
  // The process must be ended explicitly (Prisma/RabbitMQ keep the loop alive),
  // and that forced exit can abort noisily in the container. The framed result
  // on stdout is the contract; a signal after it is not a scenario failure.
  let output = ''
  try {
    output = docker(ctx, 'exec', '-T', service, 'node', '--import', 'tsx', '-e', script)
  } catch (error) {
    output = String(error?.stdout ?? '') + String(error?.stderr ?? '')
    const index = output.lastIndexOf('__INJECT_RESULT__')
    if (index < 0) throw error
    return JSON.parse(output.slice(index + '__INJECT_RESULT__'.length).trim())
  }
  const index = output.lastIndexOf('__INJECT_RESULT__')
  assert.ok(index >= 0, 'injected script produced no result: ' + output.slice(0, 400))
  return JSON.parse(output.slice(index + '__INJECT_RESULT__'.length).trim())
}

// V09: wallet credit committed, payment DB update lost, recovery must replay once.
export async function v09(ctx, state) {
  const user = state.user
  const topup = await create(ctx, user)
  const before = userBalance(ctx, user.id)

  const credited = inject(ctx, 'wallet-service',
    "const {LedgerService}=require('./src/services/ledger.service');" +
    "const r=await new LedgerService().credit('" + user.id + "',{amount:'" + AMOUNT +
    "',referenceId:'" + topup.code + "',transferType:'TOPUP'});return {transactionId:r.transactionId}")
  assert.match(String(credited.transactionId), /^[0-9a-f-]{36}$/)
  assert.deepEqual(ledgerShape(ctx, topup.code), { rows: 2, transactions: 1 })

  // The credit is committed but the payment row never learned about it.
  sql(ctx, 'payment_service',
    `UPDATE "TopupRequest" SET status='PROCESSING', "vnpResponseCode"='00', "updatedAt"=NOW()-INTERVAL '5 minutes'
     WHERE id='${topup.id}'`)

  const recovered = inject(ctx, 'payment-service',
    "const {TopupService}=require('./src/services/topup.service');" +
    "return await new TopupService().recoverStuckTopups(5)")
  // The scheduled worker runs every minute and may claim the row before this
  // explicit pass, so the pass itself is not the assertion: the end state is.
  await waitFor(() => statusOf(ctx, topup.id) === 'APPROVED',
    'recovery never settled the stuck topup: ' + topup.code, 90000)

  const row = topupRow(ctx, topup.id)
  assert.equal(row.status, 'APPROVED')
  assert.equal(row.walletTransactionId, credited.transactionId, 'recovery must reuse the original transaction')
  assert.equal(userBalance(ctx, user.id), before + AMOUNT, 'recovery must not credit twice')
  assert.deepEqual(ledgerShape(ctx, topup.code), { rows: 2, transactions: 1 })

  return { httpStatus: 200, errorCode: 'recovered',
    walletReferenceId: topup.code, ledgerInvariant: 'one credit across crash window',
    notes: 'manual pass: ' + JSON.stringify(recovered) }
}

// V08 = A6-R: wallet down -> 99/PROCESSING; wallet back -> job approves; one credit.
export async function a6r(ctx, state) {
  const user = state.user
  const before = userBalance(ctx, user.id)
  const topup = await create(ctx, user)
  // Log window opens before the wallet comes back, so the assertion can only be
  // satisfied by this scenario's recovery pass, not an earlier one.
  const since = new Date(Date.now() - 1000).toISOString()
  try {
    await command(ctx, 'a6r-stop-wallet', 'docker', [...ctx.composeArgs, 'stop', 'wallet-service'])
    const response = await sendIpn(ctx, paidParams({ code: topup.code }))
    assert.equal(response.httpStatus, 200)
    assert.equal(response.RspCode, '99', 'an unknown wallet outcome must not be acknowledged')
    assert.equal(statusOf(ctx, topup.id), 'PROCESSING', 'uncertain money must never be FAILED')
    assert.equal(ledgerCount(ctx, topup.code), 0)
  } finally {
    await command(ctx, 'a6r-start-wallet', 'docker', [...ctx.composeArgs, 'up', '-d', '--no-deps',
      '--wait', '--wait-timeout', '180', 'wallet-service'])
  }

  await waitFor(() => statusOf(ctx, topup.id) === 'APPROVED',
    'the recovery job did not approve the stuck topup within 5 minutes')

  assert.equal(userBalance(ctx, user.id), before + AMOUNT,
    'recovery must credit the exact amount once')
  assert.deepEqual(ledgerShape(ctx, topup.code), { rows: 2, transactions: 1 })

  const logs = docker(ctx, 'logs', '--no-color', '--since', since, 'payment-service')
  writeFileSync(resolve(ctx.directory, 'a6r-payment.log'), logs)
  assert.match(logs, /\[Job:recoverTopups\] approved=1/,
    'the scheduled recovery job, not a manual retry, must have settled the row')

  const row = topupRow(ctx, topup.id)
  assert.match(String(row.walletTransactionId), /^[0-9a-f-]{36}$/)
  return { httpStatus: 200, errorCode: '99 then recovered',
    walletReferenceId: topup.code, ledgerInvariant: 'PROCESSING -> APPROVED, exactly one credit' }
}

export function assertSetup(ctx) {
  if (!ctx.config.VNP_TMN_CODE || !ctx.config.VNP_HASH_SECRET) {
    throw new Blocked('VNPAY_TMN_CODE/VNP_HASH_SECRET are not configured for the isolated run')
  }
}
