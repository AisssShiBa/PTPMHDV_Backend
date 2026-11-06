// Week 3 / H12 cash-out matrix (C01-C15) against a real HTTP stack.
//
// The public path is blocked by another owner's Gateway whitelist: PUBLIC_ROUTES
// contains /^\/api\/funding(\/.*)?$/, so a Bearer token never becomes an
// x-gateway-token and requireGateway answers 401. The money scenarios therefore
// call the *real* payment-service routes from inside the stack: a Gateway token
// is minted with the Gateway's own ES256 key and the request goes over HTTP to
// payment-service. That keeps every assertion answered by the real service,
// real Postgres and real wallet-service. The Gateway-proxied route is reported
// separately as GATEWAY-CASHOUT-ROUTE (owner: Dat, STOP-3).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { root, account, call, sql, docker, command, uuid, until, pause } from '../week2/runtime.mjs'
import { Blocked } from './reporting.mjs'

const MARK = '__CASHOUT_RESULT__'
const PIN = '741852'
// Short enough that C13 can watch the hold outlive several TTLs while the bank is
// UNKNOWN, long enough that every other scenario settles its hold synchronously.
export const HOLD_TTL_MS = 30000

// ---------------------------------------------------------------- transport

// Runs a Node script inside the Gateway container (it owns the ES256 private
// key and sits on internal_net). Requests/response are marshalled through a
// marker frame so no shell quoting is involved.
export async function directMany(ctx, requests) {
  const script = 'const MARK=' + JSON.stringify(MARK) + ';' +
    'const done=(value)=>{process.stdout.write(MARK+JSON.stringify(value),()=>process.exit(0))};' +
    'const fail=(error)=>{process.stderr.write(String(error&&error.stack||error&&error.message||error),()=>process.exit(1))};' +
    'Promise.resolve().then(async()=>{' +
    'const {signGatewayToken}=require("./src/utils/gatewayToken");' +
    'const specs=' + JSON.stringify(requests) + ';' +
    'const tokens={};' +
    'for(const spec of specs){const key=spec.userId+"|"+spec.role+"|"+spec.kycTier;' +
    'if(!tokens[key])tokens[key]=signGatewayToken(spec.userId,spec.role,spec.kycTier)}' +
    'return Promise.all(specs.map(async(spec)=>{' +
    'try{' +
    'const key=spec.userId+"|"+spec.role+"|"+spec.kycTier;' +
    'const headers={"content-type":"application/json","x-gateway-token":tokens[key],...(spec.headers||{})};' +
    'const response=await fetch("http://payment-service:3005"+spec.path,{method:spec.method||"POST",headers,' +
    'body:spec.body===undefined?undefined:JSON.stringify(spec.body),signal:AbortSignal.timeout(30000)});' +
    'const text=await response.text();let json=null;try{json=JSON.parse(text)}catch{}' +
    'return {status:response.status,body:json,text:json?null:text.slice(0,300)}' +
    '}catch(error){return {status:null,error:String(error&&error.message||error)}}' +
    '}))' +
    '}).then(done).catch(fail)'
  return parseMarker(execIn(ctx, 'gateway', script))
}

export async function direct(ctx, request) {
  const [result] = await directMany(ctx, [request])
  return result
}

// Runs a script inside a service container and returns its stdout.
export function runIn(ctx, service, script) {
  return docker(ctx, 'exec', '-T', service, 'node', '--import', 'tsx', '-e', script)
}

// Scripts end with a forced process.exit(0) to kill Prisma/RabbitMQ handles, and
// the exec shim can still report a non-zero code after the frame is written; the
// marker has to be recovered from the captured streams, not from the exit code.
export function execIn(ctx, service, script) {
  try {
    return runIn(ctx, service, script)
  } catch (error) {
    const output = String(error?.stdout ?? '') + String(error?.stderr ?? '')
    if (!output.includes(MARK)) throw error
    return output
  }
}

// Runs a script inside payment-service and returns the JSON value it resolves.
export function evaluate(ctx, body) {
  const script = 'const MARK=' + JSON.stringify(MARK) + ';' +
    'const done=(value)=>{process.stdout.write(MARK+JSON.stringify(value),()=>process.exit(0))};' +
    'const fail=(error)=>{process.stderr.write(String(error&&error.stack||error&&error.message||error),()=>process.exit(1))};' +
    'require("./src/config/secrets");' +
    'Promise.resolve().then(async()=>{' + body + '}).then(done).catch(fail)'
  return parseMarker(execIn(ctx, 'payment-service', script))
}

function parseMarker(output) {
  const index = String(output).lastIndexOf(MARK)
  assert.ok(index >= 0, 'injected script produced no result: ' + String(output).slice(0, 400))
  return JSON.parse(String(output).slice(index + MARK.length).trim())
}

// ---------------------------------------------------------------- api helpers

function createRequest(user, amount, key = uuid(), destination) {
  return {
    path: '/api/funding/cash-out', method: 'POST', userId: user.id, role: user.role || 'USER', kycTier: 0,
    headers: { 'Idempotency-Key': key },
    body: { amount: String(amount), ...(destination === undefined ? {} : { destination }) },
  }
}

function confirmRequest(user, id, token) {
  return {
    path: '/api/funding/cash-out/' + id + '/confirm', method: 'POST',
    userId: user.id, role: user.role || 'USER', kycTier: 0,
    headers: { 'x-transaction-token': token }, body: {},
  }
}

export function createCashOut(ctx, user, amount, key = uuid()) {
  return direct(ctx, createRequest(user, amount, key))
}

export function confirmCashOut(ctx, user, id, token) {
  return direct(ctx, confirmRequest(user, id, token))
}

export const holdReference = id => 'cashout_' + id
export const payoutReference = id => 'cashoutpay_' + id

async function setupPin(ctx, user) {
  if (user.hasPin) return
  await call(ctx, '/auth/pin/setup', {
    method: 'POST', token: user.token, expected: 201, body: { pin: PIN, confirmPin: PIN },
  })
  user.hasPin = true
}

export async function pinToken(ctx, user, paymentId, amount) {
  await setupPin(ctx, user)
  return (await call(ctx, '/auth/pin/verify', {
    method: 'POST', token: user.token, body: { pin: PIN, paymentId, amount: String(amount) },
  })).data.transactionToken
}

export async function funded(ctx, state, label, amount = '1000000') {
  const user = await account(ctx, label)
  await call(ctx, '/wallets/' + user.id + '/credit', {
    method: 'POST', token: state.admin.token,
    body: { amount, referenceId: uuid(), transferType: 'TOPUP' },
  })
  return user
}

// ---------------------------------------------------------------- db readers

function one(ctx, database, statement) {
  const output = sql(ctx, database, statement).trim()
  return output ? JSON.parse(output) : null
}
function count(ctx, database, statement) {
  return Number(sql(ctx, database, statement).trim() || 0)
}

const walletState = (ctx, userId) => one(ctx, 'wallet_service',
  `SELECT json_build_object('balance', balance, 'held', "heldBalance") FROM "Wallet"
   WHERE "userId"='${userId}' AND "ownerType"='USER'`)

const cashOut = (ctx, id) => one(ctx, 'payment_service',
  `SELECT json_build_object('status', status, 'workflow', workflow, 'failureReason', "failureReason",
   'providerRef', "providerRef",
   'leaseUntil', to_char("leaseUntil", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) FROM "CashOut" WHERE id='${id}'`)

// expiresAt/createdAt are naive TIMESTAMP(3) columns: psql prints them without an
// offset, and Node would parse the bare string as *local* time, shifting every
// comparison by the host's UTC offset. Prisma stores these as UTC, so render them
// as explicit UTC instants instead of letting Date guess.
const hold = (ctx, referenceId) => one(ctx, 'wallet_service',
  `SELECT json_build_object('status', status, 'amount', amount, 'transactionId', "transactionId",
   'expiresAt', to_char("expiresAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'createdAt', to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
   FROM "WalletHold" WHERE "referenceId"='${referenceId}'`)

const payout = (ctx, providerRef) => one(ctx, 'payment_service',
  `SELECT json_build_object('result', result, 'timeoutResponse', "timeoutResponse",
   'bankTransactionId', "bankTransactionId", 'failureCode', "failureCode")
   FROM "MockPayout" WHERE "providerRef"='${providerRef}'`)

const payoutCount = (ctx, providerRef) =>
  count(ctx, 'payment_service', `SELECT count(*) FROM "MockPayout" WHERE "providerRef"='${providerRef}'`)

const ledgerShape = (ctx, referenceId) => one(ctx, 'wallet_service',
  `SELECT json_build_object('rows', count(*), 'transactions', count(DISTINCT "transactionId"),
   'debits', count(*) FILTER (WHERE direction='DEBIT'),
   'credits', count(*) FILTER (WHERE direction='CREDIT'),
   'balanced', (COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE 0 END),0)
              = COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE 0 END),0)))
   FROM "LedgerEntry" WHERE "referenceId"='${referenceId}'`)

const counterparty = (ctx, referenceId) => sql(ctx, 'wallet_service',
  `SELECT e.direction || ':' || w."systemCode" FROM "LedgerEntry" e
   JOIN "Wallet" w ON w.id = e."walletId"
   WHERE e."referenceId"='${referenceId}' AND w."ownerType"='SYSTEM'`)

const usedJti = (ctx, paymentId) => sql(ctx, 'payment_service',
  `SELECT "jti" FROM "UsedTransactionToken" WHERE "paymentId"='${paymentId}' LIMIT 1`).trim()

// The recovery cron drives any non-terminal row every minute, so a confirm may
// legitimately answer 200/503 with the work still in flight. The durable row is
// the authoritative answer; these helpers wait for it instead of trusting one
// HTTP snapshot or one drive() return value.
async function settle(ctx, id, status, timeout = 45000) {
  const deadline = Date.now() + timeout
  let row
  while (Date.now() < deadline) {
    row = cashOut(ctx, id)
    if (row?.status === status) return row
    await pause(500)
  }
  throw new Error('cash-out ' + id + ' never reached ' + status + ' (saw ' +
    String(row?.status) + '/' + String(row?.workflow) + ')')
}
const IN_FLIGHT = new Set(['CASHOUT_PROCESSING', 'CASHOUT_PAYOUT_PENDING'])

function accepted(responses) {
  return responses.filter(row => row.status === 200 ||
    (row.status === 503 && IN_FLIGHT.has(row.body?.error?.code)))
}

function assertNoMovement(ctx, id) {
  assert.equal(hold(ctx, holdReference(id)), null, 'no hold may exist for ' + id)
  assert.equal(payoutCount(ctx, payoutReference(id)), 0, 'no payout may exist for ' + id)
  const shape = ledgerShape(ctx, holdReference(id))
  assert.equal(Number(shape.rows), 0, 'no ledger rows may exist for ' + id)
}

function assertBalancePair(ctx, referenceId) {
  const shape = ledgerShape(ctx, referenceId)
  assert.equal(Number(shape.rows), 2, referenceId + ' must have exactly 2 ledger rows')
  assert.equal(Number(shape.transactions), 1, referenceId + ' must be one transaction')
  assert.equal(Number(shape.debits), 1, referenceId + ' must have one debit')
  assert.equal(Number(shape.credits), 1, referenceId + ' must have one credit')
  assert.equal(shape.balanced, true, referenceId + ' must debit exactly what it credits')
}

// ---------------------------------------------------------------- scenarios

export async function c01(ctx, state) {
  const user = await funded(ctx, state, 'c01')
  const before = walletState(ctx, user.id)
  const created = await createCashOut(ctx, user, '100000')
  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.equal(created.body.data.status, 'REQUESTED')
  const id = created.body.data.id

  const confirmed = await confirmCashOut(ctx, user, id, await pinToken(ctx, user, id, '100000'))
  assert.ok(accepted([confirmed]).length === 1,
    'confirm must answer 200 or an in-flight 503: ' + JSON.stringify(confirmed.body))
  await settle(ctx, id, 'SUCCEEDED')

  assert.equal(hold(ctx, holdReference(id)).status, 'CAPTURED')
  assertBalancePair(ctx, holdReference(id))
  assert.equal(payout(ctx, payoutReference(id)).result, 'SUCCESS')
  assert.equal(payoutCount(ctx, payoutReference(id)), 1)

  const after = walletState(ctx, user.id)
  assert.equal(Number(after.balance), Number(before.balance) - 100000)
  assert.equal(Number(after.held), 0)

  state.successful.push(holdReference(id))
  const system = counterparty(ctx, holdReference(id))
  assert.ok(system, 'the capture credit must land in a SYSTEM wallet')
  return { httpStatus: confirmed.status,
    errorCode: confirmed.status === 200 ? null : confirmed.body?.error?.code ?? null,
    walletReferenceId: holdReference(id),
    ledgerInvariant: 'user -100000, system +100000, 1 debit / 1 credit, hold CAPTURED',
    notes: 'hold -> SUCCESS payout -> one capture; ledger 1 debit + 1 credit; counterparty ' + system }
}

// Plan §5.4/K12 requires the capture counterpart to be SYSTEM SETTLEMENT; the
// wallet enum was MAIN/FEE/TOPUP_POOL and captureHold targeted MAIN, which is
// why this row was BLOCKED before the K12 migration.
export async function k12Counterparty(ctx, state) {
  if (!state.successful.length) throw new Blocked('C01 did not produce a captured ledger pair')
  const reference = state.successful[0]
  const observed = counterparty(ctx, reference)
  if (observed === 'CREDIT:SETTLEMENT') {
    return { notes: 'capture counterparty is SETTLEMENT' }
  }
  throw new Blocked('capture counterparty is ' + (observed || 'missing') +
    '; plan §5.4 K12 expects CREDIT:SETTLEMENT (owner: Huu, plan §14 item 7)')
}

export async function c02(ctx, state) {
  const user = await funded(ctx, state, 'c02', '300000')
  const before = walletState(ctx, user.id)
  const created = await createCashOut(ctx, user, '100111')
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const id = created.body.data.id

  const confirmed = await confirmCashOut(ctx, user, id, await pinToken(ctx, user, id, '100111'))
  const inline = confirmed.status === 409
  if (inline) {
    assert.equal(confirmed.body.error.code, 'CASHOUT_FAILED', JSON.stringify(confirmed.body))
    assert.match(String(confirmed.body.error.message), /BANK_DECLINED/)
  } else {
    assert.ok(accepted([confirmed]).length === 1,
      'confirm must answer 409 CASHOUT_FAILED or an in-flight 503: ' + JSON.stringify(confirmed.body))
  }

  const row = await settle(ctx, id, 'FAILED')
  assert.equal(row.failureReason, 'BANK_DECLINED')
  assert.equal(hold(ctx, holdReference(id)).status, 'RELEASED')
  assert.equal(payout(ctx, payoutReference(id)).result, 'FAILED')
  assert.equal(Number(ledgerShape(ctx, holdReference(id)).rows), 0)

  const after = walletState(ctx, user.id)
  assert.equal(Number(after.balance), Number(before.balance))
  assert.equal(Number(after.held), 0)
  return { httpStatus: confirmed.status,
    errorCode: confirmed.body?.error?.code ?? null,
    walletReferenceId: holdReference(id),
    ledgerInvariant: 'balance unchanged, heldBalance 0, hold RELEASED, 0 capture rows',
    notes: 'declined payout released the hold; available balance and heldBalance restored' }
}

export async function c03(ctx, state) {
  const user = await funded(ctx, state, 'c03')
  const created = await createCashOut(ctx, user, '100222')
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const id = created.body.data.id

  const first = await confirmCashOut(ctx, user, id, await pinToken(ctx, user, id, '100222'))
  // An UNKNOWN payout returns null out of drive(), so the controller's 503 is
  // CASHOUT_PROCESSING; the durable row is what proves PAYOUT_PENDING.
  assert.equal(first.status, 503, JSON.stringify(first.body))
  assert.equal(first.body.error.code, 'CASHOUT_PROCESSING')

  const pending = cashOut(ctx, id)
  assert.equal(pending.status, 'PAYOUT_PENDING')
  assert.equal(pending.workflow, 'AWAIT_RECONCILE')
  assert.equal(hold(ctx, holdReference(id)).status, 'PENDING', 'an UNKNOWN payout must not release the hold')
  assert.equal(payout(ctx, payoutReference(id)).result, 'PENDING')
  assert.equal(payoutCount(ctx, payoutReference(id)), 1)

  // Asking again while the provider is still UNKNOWN must not move money twice.
  // Still-PENDING reconciliation also returns null, so read the row, not drive().
  await evaluate(ctx, `const {CashOutService}=require('./src/funding/services/cashout.service');
    await new CashOutService().drive('${id}');
    return {ok:true};`)
  const again = cashOut(ctx, id)
  assert.equal(again.status, 'PAYOUT_PENDING')
  assert.equal(again.workflow, 'AWAIT_RECONCILE')
  assert.equal(payoutCount(ctx, payoutReference(id)), 1)

  // The provider concludes SUCCESS: exactly one capture, one ledger pair. The
  // scheduled recovery pass may win the drive, so the terminal state is read
  // from the row rather than from this call's return value.
  await evaluate(ctx, `const {MockPayoutService}=require('./src/funding/services/mock-payout.service');
    const {CashOutService}=require('./src/funding/services/cashout.service');
    await new MockPayoutService().resolve('${payoutReference(id)}','SUCCESS');
    await new CashOutService().drive('${id}');
    return {ok:true};`)
  await until(() => cashOut(ctx, id).status === 'SUCCEEDED',
    'the provider SUCCESS was never reconciled into exactly one capture', 30000)
  const settled = cashOut(ctx, id)
  assert.equal(hold(ctx, holdReference(id)).status, 'CAPTURED',
    'the hold extended across AWAIT_RECONCILE must still be the one that captures')
  assertBalancePair(ctx, holdReference(id))
  assert.equal(payoutCount(ctx, payoutReference(id)), 1)

  state.successful.push(holdReference(id))
  writeFileSync(resolve(ctx.directory, 'c03-evidence.json'), JSON.stringify({
    pendingState: pending, firstResponse: first.status, doubleDrive: again,
    settled, ledger: ledgerShape(ctx, holdReference(id)),
    note: 'PAYOUT_PENDING -> provider query -> one capture; the hold was kept alive by extend (C13).',
  }, null, 2))

  return { httpStatus: first.status, errorCode: first.body?.error?.code ?? null,
    walletReferenceId: holdReference(id),
    ledgerInvariant: 'while UNKNOWN: balance unchanged, hold PENDING; after query: hold CAPTURED, 1 debit / 1 credit',
    notes: 'UNKNOWN payout -> PAYOUT_PENDING -> provider query -> exactly one capture; the hold survives the window' }
}

export async function c04(ctx, state) {
  const user = await funded(ctx, state, 'c04')
  const key = uuid()
  const first = await createCashOut(ctx, user, '100000', key)
  const second = await createCashOut(ctx, user, '100000', key)
  assert.equal(first.status, 201, JSON.stringify(first.body))
  assert.equal(second.status, 201, JSON.stringify(second.body))
  assert.equal(second.body.data.id, first.body.data.id)
  assert.equal(second.body.data.replayed, true)
  assert.equal(count(ctx, 'payment_service',
    `SELECT count(*) FROM "CashOut" WHERE "userId"='${user.id}' AND "idempotencyKey"='${key}'`), 1)
  assertNoMovement(ctx, first.body.data.id)
  return { httpStatus: second.status, walletReferenceId: holdReference(first.body.data.id),
    ledgerInvariant: 'no hold, no payout, 0 ledger rows; one CashOut row',
    notes: 'same Idempotency-Key replays one CashOut row' }
}

export async function c05(ctx, state) {
  const user = await funded(ctx, state, 'c05')
  const key = uuid()
  const first = await createCashOut(ctx, user, '100000', key)
  assert.equal(first.status, 201, JSON.stringify(first.body))
  const conflicting = await createCashOut(ctx, user, '100500', key)
  assert.equal(conflicting.status, 422, JSON.stringify(conflicting.body))
  assert.equal(conflicting.body.error.code, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD')
  assert.equal(count(ctx, 'payment_service',
    `SELECT count(*) FROM "CashOut" WHERE "userId"='${user.id}' AND "idempotencyKey"='${key}'`), 1)
  assertNoMovement(ctx, first.body.data.id)
  return { httpStatus: conflicting.status,
    errorCode: conflicting.body?.error?.code ?? null,
    walletReferenceId: holdReference(first.body.data.id),
    ledgerInvariant: 'no hold, no payout, 0 ledger rows; one CashOut row',
    notes: 'same key with a different amount is rejected before any effect' }
}

export async function c06(ctx, state) {
  const user = await funded(ctx, state, 'c06')
  const created = await createCashOut(ctx, user, '100000')
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const id = created.body.data.id
  const token = await pinToken(ctx, user, id, '100000')

  const responses = await directMany(ctx, Array.from({ length: 20 }, () => confirmRequest(user, id, token)))
  const winners = responses.filter(row => row.status !== 409)
  const reused = responses.filter(row => row.status === 409 && row.body?.error?.code === 'TXN_TOKEN_REUSED')
  assert.equal(winners.length, 1,
    'exactly one confirm may win: ' + JSON.stringify(responses.map(row => row.body?.error?.code || row.status)))
  assert.equal(accepted(winners).length, 1,
    'the winner must answer 200 or an in-flight 503: ' + JSON.stringify(winners[0]?.body))
  assert.equal(reused.length, 19,
    'the other 19 must be rejected as token reuse: ' +
    JSON.stringify(responses.map(row => row.body?.error?.code || row.status)))

  await settle(ctx, id, 'SUCCEEDED')
  assert.equal(count(ctx, 'wallet_service',
    `SELECT count(*) FROM "WalletHold" WHERE "referenceId"='${holdReference(id)}'`), 1)
  assert.equal(payoutCount(ctx, payoutReference(id)), 1)
  assertBalancePair(ctx, holdReference(id))

  state.successful.push(holdReference(id))
  return { httpStatus: winners[0].status,
    errorCode: winners[0].body?.error?.code ?? null,
    walletReferenceId: holdReference(id),
    ledgerInvariant: '1 claim, 1 hold CAPTURED, 1 payout, 1 debit / 1 credit',
    notes: '20 parallel confirms -> 1 claim, 1 hold, 1 payout' }
}

export async function c07(ctx, state) {
  const owner = await funded(ctx, state, 'c07-owner')
  const other = await funded(ctx, state, 'c07-other')
  const target = await createCashOut(ctx, owner, '100000')
  const decoy = await createCashOut(ctx, owner, '100000')
  assert.equal(target.status, 201, JSON.stringify(target.body))
  assert.equal(decoy.status, 201, JSON.stringify(decoy.body))
  const id = target.body.data.id

  const foreignUser = await confirmCashOut(ctx, other, id, await pinToken(ctx, other, id, '100000'))
  assert.equal(foreignUser.status, 403, JSON.stringify(foreignUser.body))
  assert.equal(foreignUser.body.error.code, 'TXN_TOKEN_MISMATCH')

  const foreignPayment = await confirmCashOut(ctx, owner, id, await pinToken(ctx, owner, decoy.body.data.id, '100000'))
  assert.equal(foreignPayment.status, 403, JSON.stringify(foreignPayment.body))
  assert.equal(foreignPayment.body.error.code, 'TXN_TOKEN_MISMATCH')

  const foreignAmount = await confirmCashOut(ctx, owner, id, await pinToken(ctx, owner, id, '100500'))
  assert.equal(foreignAmount.status, 403, JSON.stringify(foreignAmount.body))
  assert.equal(foreignAmount.body.error.code, 'TXN_TOKEN_MISMATCH')

  assertNoMovement(ctx, id)
  assertNoMovement(ctx, decoy.body.data.id)
  return { httpStatus: foreignUser.status, errorCode: foreignUser.body?.error?.code ?? null,
    walletReferenceId: holdReference(id),
    ledgerInvariant: 'no hold, no payout, 0 ledger rows for either cash-out',
    notes: 'other user / other paymentId / other amount all answer 403 with no hold' }
}

export async function c08(ctx, state) {
  const user = await funded(ctx, state, 'c08')
  const created = await createCashOut(ctx, user, '100000')
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const id = created.body.data.id
  await setupPin(ctx, user)

  // Same signer code as the service, run under a fake clock in its own process.
  const expired = runIn(ctx, 'auth-service',
    `const {signTransactionToken}=require('./src/utils/transactionToken');` +
    `Date.now=()=>${Date.now() - 65000};` +
    `console.log(signTransactionToken('${user.id}','${id}','100000'))`).trim()

  const confirmed = await confirmCashOut(ctx, user, id, expired)
  assert.equal(confirmed.status, 401, JSON.stringify(confirmed.body))
  assert.equal(confirmed.body.error.code, 'TXN_TOKEN_EXPIRED')
  assertNoMovement(ctx, id)
  return { httpStatus: confirmed.status, errorCode: confirmed.body?.error?.code ?? null,
    walletReferenceId: holdReference(id),
    ledgerInvariant: 'no hold, no payout, 0 ledger rows',
    notes: 'a token older than 60s answers 401 TXN_TOKEN_EXPIRED and holds nothing' }
}

export async function c09(ctx, state) {
  const user = await funded(ctx, state, 'c09')
  const partner = await funded(ctx, state, 'c09-partner')

  // Consume a real jti in the Payment domain first.
  const checkout = await call(ctx, '/payments/checkout', {
    method: 'POST', token: user.token, expected: 201, headers: { 'Idempotency-Key': uuid() },
    body: { type: 'WALLET_TRANSFER', destinationUserId: partner.id, amount: '50000' },
  })
  const payment = checkout.data
  await call(ctx, '/payments/' + payment.id + '/confirm', {
    method: 'POST', token: user.token, body: { transactionToken: await pinToken(ctx, user, payment.id, '50000') },
  })
  const jti = usedJti(ctx, payment.id)
  assert.ok(jti, 'the Payment confirm must have consumed a jti')

  const created = await createCashOut(ctx, user, '50000')
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const id = created.body.data.id

  const replay = await evaluate(ctx, `const {CashOutService}=require('./src/funding/services/cashout.service');
    const {DomainException}=require('./src/utils/domain.exception');
    try{
      await new CashOutService().confirm('${id}','${user.id}',
        {sub:'${user.id}',paymentId:'${id}',amount:'50000',jti:'${jti}'});
      return {rejected:false};
    }catch(error){
      return {rejected:true,status:error instanceof DomainException?error.status:null,code:error&&error.code};
    }`)

  assert.equal(replay.rejected, true)
  assert.equal(replay.status, 409)
  assert.equal(replay.code, 'TXN_TOKEN_REUSED')
  assert.equal(cashOut(ctx, id).status, 'REQUESTED')
  assertNoMovement(ctx, id)
  return { httpStatus: replay.status, errorCode: replay.code,
    walletReferenceId: holdReference(id),
    ledgerInvariant: 'no hold, no payout, 0 ledger rows; CashOut stays REQUESTED',
    notes: 'a jti consumed by a Payment is rejected for CashOut with 409 and no money moves' }
}

export async function c10(ctx, state) {
  const user = await funded(ctx, state, 'c10')
  const created = await createCashOut(ctx, user, '100000')
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const id = created.body.data.id
  const token = await pinToken(ctx, user, id, '100000')

  let failure
  try {
    await command(ctx, 'c10-stop-wallet', 'docker', [...ctx.composeArgs, 'stop', 'wallet-service'])
    const confirmed = await confirmCashOut(ctx, user, id, token)
    assert.equal(confirmed.status, 503, JSON.stringify(confirmed.body))
    assert.equal(confirmed.body.error.code, 'CASHOUT_PROCESSING')
    failure = cashOut(ctx, id)
    assert.equal(failure.status, 'HOLDING', 'an unreachable Wallet must not be treated as a settled hold')
    assert.equal(hold(ctx, holdReference(id)), null)
    assert.equal(payoutCount(ctx, payoutReference(id)), 0, 'no payout may be issued without a hold')
  } finally {
    await command(ctx, 'c10-start-wallet', 'docker',
      [...ctx.composeArgs, 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', 'wallet-service'])
  }

  await evaluate(ctx, `const {CashOutService}=require('./src/funding/services/cashout.service');
    await new CashOutService().drive('${id}');
    return {ok:true};`)
  await settle(ctx, id, 'SUCCEEDED', 60000)
  assert.equal(count(ctx, 'wallet_service',
    `SELECT count(*) FROM "WalletHold" WHERE "referenceId"='${holdReference(id)}'`), 1)
  assert.equal(payoutCount(ctx, payoutReference(id)), 1)
  assertBalancePair(ctx, holdReference(id))

  state.successful.push(holdReference(id))
  return { httpStatus: 503, errorCode: 'CASHOUT_PROCESSING',
    walletReferenceId: holdReference(id),
    ledgerInvariant: 'no hold during the outage; after recovery 1 hold CAPTURED and 1 debit / 1 credit',
    notes: 'Wallet outage before the hold: recovery created one hold, then one payout' }
}

export async function c11(ctx, state) {
  const user = await funded(ctx, state, 'c11')
  const created = await createCashOut(ctx, user, '100000')
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const id = created.body.data.id
  await setupPin(ctx, user)
  const jti = uuid()

  // Dies the instant the workflow reaches Capture, after the payout row is durable.
  runIn(ctx, 'payment-service',
    `const {CashOutService}=require('./src/funding/services/cashout.service');` +
    `const {WalletClient}=require('./src/clients/wallet.client');` +
    `class Dead extends WalletClient{async captureHold(){process.exit(0)}}` +
    `new CashOutService(new Dead()).confirm('${id}','${user.id}',` +
    `{sub:'${user.id}',paymentId:'${id}',amount:'100000',jti:'${jti}'})` +
    `.then(()=>process.exit(0)).catch(()=>process.exit(1))`)

  // The crash must leave the payout durable and no money moved yet. The
  // scheduled pass cannot claim the row while the dead worker's lease is live,
  // but read the combination rather than assuming which process observes it.
  const crashed = cashOut(ctx, id)
  assert.equal(payout(ctx, payoutReference(id)).result, 'SUCCESS', 'the payout must be durable before the crash')
  if (crashed.status === 'SUCCEEDED') {
    assertBalancePair(ctx, holdReference(id))
  } else {
    assert.equal(crashed.status, 'HOLDING')
    assert.equal(crashed.workflow, 'CAPTURING')
    assert.equal(hold(ctx, holdReference(id)).status, 'PENDING')
    assert.equal(Number(ledgerShape(ctx, holdReference(id)).rows), 0)
  }

  // A restarted worker waits out the lease, then continues the same workflow.
  sql(ctx, 'payment_service',
    `UPDATE "CashOut" SET "leaseUntil"=now() - interval '1 second' WHERE id='${id}'`)
  await evaluate(ctx, `const {CashOutService}=require('./src/funding/services/cashout.service');
    const scanned=await new CashOutService().recover();
    await new CashOutService().drive('${id}');
    return {scanned};`)
  await settle(ctx, id, 'SUCCEEDED', 60000)
  assert.equal(hold(ctx, holdReference(id)).status, 'CAPTURED')
  assertBalancePair(ctx, holdReference(id))
  assert.equal(payoutCount(ctx, payoutReference(id)), 1, 'the same providerRef must not create a second payout')

  state.successful.push(holdReference(id))
  return { walletReferenceId: holdReference(id),
    ledgerInvariant: '1 payout under one providerRef, hold CAPTURED, 1 debit / 1 credit',
    notes: 'crash after the payout: restart captured once under the same providerRef' }
}

export async function c12(ctx, state) {
  const user = await funded(ctx, state, 'c12')
  const created = await createCashOut(ctx, user, '100000')
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const id = created.body.data.id
  await setupPin(ctx, user)
  const jti = uuid()

  // The capture lands, but the response is lost: the service cannot conclude.
  // An ambiguous capture returns null from drive(), so the durable row is the
  // evidence that the workflow stayed short of a terminal state.
  await evaluate(ctx, `const {CashOutService}=require('./src/funding/services/cashout.service');
    const {WalletClient}=require('./src/clients/wallet.client');
    const {DomainException}=require('./src/utils/domain.exception');
    class Lost extends WalletClient{async captureHold(...args){await super.captureHold(...args);
      throw new DomainException(503,'WALLET_UNAVAILABLE','simulated lost capture response')}}
    await new CashOutService(new Lost()).confirm('${id}','${user.id}',
      {sub:'${user.id}',paymentId:'${id}',amount:'100000',jti:'${jti}'});
    return {ok:true};`)
  const lost = cashOut(ctx, id)
  assert.notEqual(lost.status, 'SUCCEEDED', 'a lost capture response must not be recorded as success')
  assert.notEqual(lost.status, 'FAILED', 'a lost capture response must not be recorded as failure')
  assert.equal(hold(ctx, holdReference(id)).status, 'CAPTURED')
  assert.equal(Number(ledgerShape(ctx, holdReference(id)).rows), 2)

  await evaluate(ctx, `const {CashOutService}=require('./src/funding/services/cashout.service');
    await new CashOutService().drive('${id}');
    return {ok:true};`)
  await settle(ctx, id, 'SUCCEEDED', 60000)
  assertBalancePair(ctx, holdReference(id))

  state.successful.push(holdReference(id))
  return { walletReferenceId: holdReference(id),
    ledgerInvariant: 'hold CAPTURED once, exactly 2 ledger rows, recovery added none',
    notes: 'lost capture response: the recovery looked up the hold and added no ledger rows' }
}

// STOP-1: the bank stays UNKNOWN for longer than the hold's own TTL. Each
// recovery pass must push `expiresAt` forward, so the Wallet sweeper never takes a
// hold that is still backing a live payout, and the eventual SUCCESS captures it.
export async function c13(ctx, state) {
  const user = await funded(ctx, state, 'c13')
  const before = walletState(ctx, user.id)
  const created = await createCashOut(ctx, user, '100222')
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const id = created.body.data.id
  const confirmed = await confirmCashOut(ctx, user, id, await pinToken(ctx, user, id, '100222'))
  assert.ok(accepted([confirmed]).length === 1,
    'confirm must answer 200 or an in-flight 503: ' + JSON.stringify(confirmed.body))
  await settle(ctx, id, 'PAYOUT_PENDING', 30000)
  assert.equal(cashOut(ctx, id).workflow, 'AWAIT_RECONCILE')

  const reference = holdReference(id)
  const initial = hold(ctx, reference)
  assert.equal(initial.status, 'PENDING')
  const initialExpiry = new Date(initial.expiresAt).getTime()
  assert.ok(initialExpiry > Date.now(), 'the hold must be created with a future expiry')
  const held = () => Number(walletState(ctx, user.id).held)
  assert.equal(held(), 100222, 'the whole amount must be held before the bank answers')

  // Re-run the recovery pass explicitly and keep watching: the observation window
  // ends two TTLs after the hold was created, i.e. long past the expiry the hold
  // was created with. The automatic sweeper runs on its own 10s schedule the whole
  // time, so any pass that left the hold expired would be taken within ~10s.
  const observations = []
  const deadline = initialExpiry + HOLD_TTL_MS
  while (Date.now() < deadline) {
    await evaluate(ctx, `const {CashOutService}=require('./src/funding/services/cashout.service');
      await new CashOutService().drive('${id}');
      return {ok:true};`)
    const current = hold(ctx, reference)
    observations.push({ at: new Date().toISOString(), status: current.status, expiresAt: current.expiresAt })
    assert.equal(current.status, 'PENDING',
      'while the bank is UNKNOWN the hold must stay PENDING, not be swept: ' + JSON.stringify(current))
    assert.ok(new Date(current.expiresAt).getTime() > Date.now(),
      'every recovery pass must leave a strictly future expiry: ' + JSON.stringify(current))
    assert.equal(held(), 100222, 'heldBalance must stay reserved for the whole UNKNOWN window')
    assert.equal(Number(ledgerShape(ctx, reference).rows), 0, 'nothing may move while the bank is UNKNOWN')
    await pause(3000)
  }

  const survived = hold(ctx, reference)
  const finalExpiry = new Date(survived.expiresAt).getTime()
  assert.equal(survived.status, 'PENDING',
    'the hold must outlive its original TTL when the bank is still UNKNOWN')
  assert.ok(Date.now() > initialExpiry, 'the window must actually outlast the original expiry')
  assert.ok(finalExpiry > Date.now(), 'the surviving hold must still be capturable')
  assert.ok(finalExpiry > initialExpiry, 'the expiry must have been pushed forward, not merely survive')

  // Only now does the bank conclude that it did move the money.
  await evaluate(ctx, `const {MockPayoutService}=require('./src/funding/services/mock-payout.service');
    const {CashOutService}=require('./src/funding/services/cashout.service');
    await new MockPayoutService().resolve('${payoutReference(id)}','SUCCESS');
    await new CashOutService().drive('${id}');
    return {ok:true};`)
  await until(() => cashOut(ctx, id).status === 'SUCCEEDED',
    'the bank SUCCESS after the UNKNOWN window was never captured', 60000)
  const settled = cashOut(ctx, id)
  assert.equal(settled.failureReason, null)
  assert.equal(hold(ctx, reference).status, 'CAPTURED')
  assertBalancePair(ctx, reference)
  assert.equal(payoutCount(ctx, payoutReference(id)), 1)

  const after = walletState(ctx, user.id)
  assert.equal(Number(after.held), 0)
  assert.equal(Number(after.balance), Number(before.balance) - 100222)

  state.successful.push(reference)
  writeFileSync(resolve(ctx.directory, 'c13-hold-extend-evidence.json'), JSON.stringify({
    bank: payout(ctx, payoutReference(id)),
    cashOut: cashOut(ctx, id),
    hold: hold(ctx, reference),
    ledger: ledgerShape(ctx, reference),
    holdTtlMs: HOLD_TTL_MS,
    initialExpiry: new Date(initialExpiry).toISOString(),
    finalExpiry: new Date(finalExpiry).toISOString(),
    observations,
    balance: { before, after },
    note: 'The bank stayed UNKNOWN beyond the hold TTL. Every recovery pass extended the hold, ' +
      'the sweeper never took it, and the eventual SUCCESS captured exactly once.',
  }, null, 2))

  return { httpStatus: confirmed.status, errorCode: confirmed.body?.error?.code ?? null,
    walletReferenceId: reference,
    ledgerInvariant: 'hold PENDING past its original TTL, then CAPTURED: user -100222, system +100222, 1 debit / 1 credit',
    notes: 'UNKNOWN bank window outlived the hold TTL; extension kept it capturable and the SUCCESS captured once' }
}

export async function c14(ctx, state) {
  const user = await funded(ctx, state, 'c14')
  const forgedKey = 'c14-forged-' + uuid()

  const probes = await evaluate(ctx, `
    const results={};
    const post=async(headers)=>{
      const response=await fetch('http://127.0.0.1:3005/internal/mock-payout/c14-probe/resolve',
        {method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({result:'SUCCESS'})});
      const text=await response.text();let json=null;try{json=JSON.parse(text)}catch{}
      return {status:response.status,code:json&&json.error&&json.error.code};
    };
    results.noKey=await post({});
    results.wrongKey=await post({'x-internal-key':'not-the-key'});
    results.validKey=await post({'x-internal-key':process.env.INTERNAL_KEY});
    const forged=await fetch('http://127.0.0.1:3005/api/funding/cash-out',{method:'POST',
      headers:{'content-type':'application/json','x-gateway-token':'not-a-gateway-token',
        'idempotency-key':'${forgedKey}'},body:JSON.stringify({amount:'100000'})});
    const forgedText=await forged.text();let forgedJson=null;try{forgedJson=JSON.parse(forgedText)}catch{}
    results.forgedToken={status:forged.status,code:forgedJson&&forgedJson.error&&forgedJson.error.code};
    return results;`)

  assert.equal(probes.noKey.status, 401, JSON.stringify(probes))
  assert.equal(probes.wrongKey.status, 401, JSON.stringify(probes))
  assert.equal(probes.validKey.status, 404)
  assert.equal(probes.validKey.code, 'PAYOUT_NOT_FOUND')
  assert.equal(probes.forgedToken.status, 401, JSON.stringify(probes))
  assert.equal(probes.forgedToken.code, 'INVALID_GATEWAY_TOKEN')
  assert.equal(count(ctx, 'payment_service',
    `SELECT count(*) FROM "CashOut" WHERE "userId"='${user.id}' AND "idempotencyKey"='${forgedKey}'`), 0)
  assert.equal(payoutCount(ctx, 'c14-probe'), 0)
  return { notes: 'internal mock and forged Gateway tokens are rejected; nothing is paid' }
}

export async function c15(ctx, state) {
  assert.ok(state.successful.length >= 4, 'expected several successful cash-outs to audit')
  for (const reference of state.successful) assertBalancePair(ctx, reference)

  const total = Number(sql(ctx, 'wallet_service', 'SELECT COALESCE(SUM(balance),0) FROM "Wallet"'))
  assert.equal(total, 0, 'SUM(Wallet.balance) must be 0')

  // Every ledger transaction in this database must be balanced, not only ours.
  const unbalanced = Number(sql(ctx, 'wallet_service',
    `SELECT count(*) FROM (SELECT "transactionId",
       SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END) AS net
       FROM "LedgerEntry" GROUP BY "transactionId" HAVING SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END) <> 0) x`))
  assert.equal(unbalanced, 0, 'every ledger transaction must debit exactly what it credits')
  return { ledgerInvariant: 'SUM(Wallet.balance) = 0, every transaction debit = credit, heldBalance >= 0',
    notes: 'audited ' + state.successful.length + ' cash-out references; system balance is 0' }
}

// Proves the durable mock bank is live for this stack before any money scenario
// runs. GET is read-only: an unknown reference answers 404 PAYOUT_NOT_FOUND when
// the mock is enabled and 404 MOCK_PAYOUT_DISABLED when it is not.
export function mockBankStatus(ctx) {
  return evaluate(ctx, `const response=await fetch("http://127.0.0.1:3005/internal/mock-payout/__probe_missing__",
    {headers:{"x-internal-key":process.env.INTERNAL_KEY}});
    const json=await response.json().catch(()=>null);
    return {status:response.status,code:json&&json.error&&json.error.code,
      enabled:Boolean(json&&json.error&&json.error.code==="PAYOUT_NOT_FOUND")};`)
}

// Gateway-proxied probe: the PUBLIC_ROUTES whitelist answers 401 until Dat
// narrows it to the VNPAY IPN/return paths (STOP-3).
export async function gatewayRoute(ctx, state) {
  const response = await call(ctx, '/funding/cash-out', {
    method: 'POST', token: state.admin.token, expected: null,
    headers: { 'Idempotency-Key': uuid() }, body: { amount: '100000' },
  })
  if (response.httpStatus === 401) {
    throw new Blocked('Gateway PUBLIC_ROUTES whitelist /^\\/api\\/funding(\\/.*)?$/ (owner: Dat) makes ' +
      'POST /api/funding/cash-out public, so no x-gateway-token is minted and requireGateway answers 401 ' +
      (response.error?.code || '') + '. STOP-3: the public cash-out route is not reachable through the Gateway. ' +
      'The C-matrix runs the same service over internal HTTP.')
  }
  if (response.httpStatus !== 201) {
    throw new Error('cash-out create with Bearer returned ' + response.httpStatus +
      ' (' + (response.error?.code || 'no code') + ')')
  }
  return { notes: 'reachable with a Bearer token; whitelist gap closed' }
}
