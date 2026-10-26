import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { account, call, sql, uuid, until, broker, docker } from './runtime.mjs'

export const walletTier = (ctx, user) => sql(ctx, 'wallet_service',
  `SELECT "kycTier" FROM "Wallet" WHERE "userId"='${user.id}' AND "ownerType"='USER'`)

function evidence(ctx, id, value) {
  ctx.walletEvidence ??= {}
  ctx.walletEvidence[id] = value
  writeFileSync(resolve(ctx.directory, 'wallet-t1.json'), JSON.stringify(ctx.walletEvidence, null, 2))
}

function state(ctx, user) {
  return JSON.parse(sql(ctx, 'wallet_service', `SELECT json_build_object(
    'balance',balance::text,'held',"heldBalance"::text,
    'usage',COALESCE((SELECT SUM("spentDay") FROM "UserDailyUsage" WHERE "userId"='${user.id}'),0)::text,
    'usageRows',(SELECT count(*) FROM "UserDailyUsage" WHERE "userId"='${user.id}'),
    'ledger',(SELECT count(*) FROM "LedgerEntry"),
    'holds',(SELECT count(*) FROM "WalletHold" WHERE "sourceWalletId"=w.id))
    FROM "Wallet" w WHERE "userId"='${user.id}' AND "ownerType"='USER'`))
}
async function fund(ctx, accounts, user, amount) {
  await call(ctx, '/wallets/' + user.id + '/credit', { method: 'POST', token: accounts.admin.token,
    body: { amount: String(amount), referenceId: 't1-funding-' + uuid(), transferType: 'TOPUP' } })
}
async function funded(ctx, accounts, label) {
  const user = await account(ctx, label)
  await fund(ctx, accounts, user, 1000000)
  assert.equal(walletTier(ctx, user), '0')
  return user
}
const operation = (ctx, accounts, user, route, body, expected = 200) => call(ctx,
  '/wallets/' + user.id + '/' + route, { method: 'POST', token: accounts.admin.token, body, expected })
const hold = (ctx, accounts, user, amount, referenceId, expiresAt, expected = 200) =>
  operation(ctx, accounts, user, 'hold', { amount: String(amount), referenceId, expiresAt,
    destinationUserId: accounts.binh.id }, expected)
const holdStatus = (ctx, referenceId) => sql(ctx, 'wallet_service',
  `SELECT status FROM "WalletHold" WHERE "referenceId"='${referenceId}'`)
function limitError(result, type) {
  assert.equal(result.httpStatus, 422)
  assert.equal(result.error?.code, 'LIMIT_EXCEEDED')
  assert.equal(result.error?.limitType, type)
  assert.equal(result.error?.kycTier, 0)
}

// Component evidence only: ADMIN calls Wallet directly. These results do not
// certify end-user Payment/PIN checkout, which remains independently BLOCKED.
export async function walletA9(ctx, accounts) {
  const user = accounts.chi
  await fund(ctx, accounts, user, 1000000)
  assert.equal(walletTier(ctx, user), '0')
  assert.equal(Number(state(ctx, user).balance), 1100000)
  const transfer = amount => operation(ctx, accounts, user, 'transfer', {
    toUserId: accounts.binh.id, amount: String(amount), referenceId: uuid()
  }, null)
  const before = [state(ctx, user), state(ctx, accounts.binh)]
  limitError(await transfer(600000), 'PER_TXN')
  assert.deepEqual([state(ctx, user), state(ctx, accounts.binh)], before,
    'Rejected per-transaction transfer must preserve balances, held funds, usage and ledger')
  for (let i = 0; i < 2; i++) assert.equal((await transfer(200000)).httpStatus, 200)
  const after = [state(ctx, user), state(ctx, accounts.binh)]
  assert.equal(Number(after[0].usage), 400000)
  assert.equal(Number(after[0].balance), 700000)
  assert.equal(Number(after[0].ledger) - Number(before[0].ledger), 4)
  limitError(await transfer(200000), 'PER_DAY')
  assert.deepEqual([state(ctx, user), state(ctx, accounts.binh)], after,
    'Rejected daily-limit transfer must not mutate balances, usage or ledger')
  evidence(ctx, 'WALLET-A9', { before, after, rejected: ['PER_TXN', 'PER_DAY'] })
}

export async function walletS6(ctx, accounts) {
  const user = await funded(ctx, accounts, 'wallet-s6')
  const before = state(ctx, user)
  const references = Array.from({ length: 10 }, () => uuid())
  const expiresAt = new Date(Date.now() + 300000).toISOString()
  for (const destinationUserId of [undefined, 'not-a-uuid']) {
    const invalid = await operation(ctx, accounts, user, 'hold', {
      amount: '100000', referenceId: uuid(), expiresAt, destinationUserId
    }, 400)
    assert.equal(invalid.error?.code, 'VALIDATION_ERROR')
    assert.deepEqual(state(ctx, user), before, 'Invalid hold recipient must not reserve funds or usage')
  }
  const results = await Promise.all(references.map(id => hold(ctx, accounts, user, 100000, id, expiresAt, null)))
  const accepted = results.filter(r => r.httpStatus === 200)
  evidence(ctx, 'WALLET-S6', { statuses: results.map(r => r.httpStatus), before, after: state(ctx, user) })
  assert.equal(accepted.length, 5, 'Exactly five of ten concurrent 100,000 VND holds must fit the 500,000 daily limit')
  for (const result of results.filter(r => r.httpStatus !== 200)) limitError(result, 'PER_DAY')
  const after = state(ctx, user)
  assert.equal(Number(after.usage), 500000)
  assert.equal(Number(after.held), 500000)
  assert.equal(after.balance, before.balance)
  assert.equal(after.ledger, before.ledger)
  assert.equal(Number(after.holds) - Number(before.holds), 5)
  for (let i = 0; i < results.length; i++) {
    assert.equal(holdStatus(ctx, references[i]), results[i].httpStatus === 200 ? 'PENDING' : '')
    if (results[i].httpStatus === 200)
      await operation(ctx, accounts, user, 'release', { referenceId: references[i] })
  }
  assert.equal(Number(state(ctx, user).usage), 0)
  assert.equal(Number(state(ctx, user).held), 0)
}

export async function s7(ctx, accounts) {
  const user = await funded(ctx, accounts, 's7')
  const baseline = uuid(), released = uuid(), expired = uuid()
  const future = new Date(Date.now() + 300000).toISOString()
  // Keep already-spent usage so an erroneous reset-to-zero cannot pass.
  await hold(ctx, accounts, user, 50000, baseline, future)
  await operation(ctx, accounts, user, 'capture', { referenceId: baseline })
  const before = state(ctx, user)
  assert.equal(Number(before.usage), 50000)
  await hold(ctx, accounts, user, 100000, released, future)
  assert.equal(Number(state(ctx, user).usage), 150000)
  await operation(ctx, accounts, user, 'release', { referenceId: released })
  await operation(ctx, accounts, user, 'release', { referenceId: released })
  assert.equal(holdStatus(ctx, released), 'RELEASED')
  assert.equal(Number(state(ctx, user).usage), 50000)
  assert.equal(Number(state(ctx, user).held), 0)
  await hold(ctx, accounts, user, 100000, expired, new Date(Date.now() + 4000).toISOString())
  assert.equal(Number(state(ctx, user).usage), 150000)
  await until(() => holdStatus(ctx, expired) === 'EXPIRED', 'S7: real hold scheduler did not expire the hold', 25000)
  await operation(ctx, accounts, user, 'release', { referenceId: expired })
  const after = state(ctx, user)
  evidence(ctx, 'S7', { before, after, released: holdStatus(ctx, released), expired: holdStatus(ctx, expired) })
  assert.equal(after.usage, before.usage, 'Release/expiry must preserve prior spent usage')
  assert.equal(after.held, before.held)
  assert.equal(after.balance, before.balance)
  assert.equal(after.ledger, before.ledger)
}

export async function inlineExpiry(ctx, accounts) {
  const user = await funded(ctx, accounts, 's7-inline')
  const referenceId = uuid(), expiresAt = new Date(Date.now() + 3600000).toISOString()
  const before = state(ctx, user)
  await hold(ctx, accounts, user, 100000, referenceId, expiresAt)
  // Separate service process, real DB, fake time. The live scheduler cannot
  // mask a rolled-back expiry because this hold is still an hour in its future.
  const result = JSON.parse(docker(ctx, 'exec', '-T', 'wallet-service', 'node', '--import', 'tsx', '-e', `
    const {WalletHoldService}=require('./src/services/wallet-hold.service');
    const {LedgerService}=require('./src/services/ledger.service');
    const RealDate=Date,now=Date.parse('${expiresAt}')+1;
    global.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[now]))}static now(){return now}};
    new WalletHoldService(new LedgerService()).captureHold('${user.id}','${referenceId}')
      .then(()=>{console.log(JSON.stringify({unexpectedSuccess:true}));process.exit(1)})
      .catch(e=>{console.log(JSON.stringify({status:e.status,code:e.code}));process.exit(0)});`))
  assert.deepEqual(result, { status: 409, code: 'HOLD_EXPIRED' })
  const after = state(ctx, user)
  const status = holdStatus(ctx, referenceId)
  evidence(ctx, 'WALLET-S7-INLINE', { response: result, status, before, after })
  assert.equal(status, 'EXPIRED', 'Inline expiry must commit EXPIRED before returning HOLD_EXPIRED')
  assert.equal(Number(after.usage), Number(before.usage))
  assert.equal(after.held, before.held)
  assert.equal(after.balance, before.balance)
  assert.equal(after.ledger, before.ledger)
  const replay = await operation(ctx, accounts, user, 'capture', { referenceId }, 409)
  assert.equal(replay.error?.code, 'HOLD_NOT_CAPTURABLE')
  assert.deepEqual(state(ctx, user), after, 'Retry after inline expiry must not refund usage twice')
}

export async function s10(ctx) {
  assert.match(ctx.project, /^finvault-acceptance-[0-9a-f]{12}$/)
  const user = await account(ctx, 's10')
  assert.equal(walletTier(ctx, user), '0')
  // Test-only audit trigger counts UPDATEs even if tier is assigned the same
  // value twice. Final tier alone cannot demonstrate eventId deduplication.
  sql(ctx, 'wallet_service', `CREATE SCHEMA acceptance_t1;
    CREATE TABLE acceptance_t1.kyc_updates (user_id text, tier int);
    CREATE FUNCTION acceptance_t1.record_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO acceptance_t1.kyc_updates VALUES (NEW."userId",NEW."kycTier"); RETURN NEW; END $$;
    CREATE TRIGGER acceptance_t1_kyc AFTER UPDATE OF "kycTier" ON "Wallet"
    FOR EACH ROW WHEN (NEW."userId"='${user.id}') EXECUTE FUNCTION acceptance_t1.record_update();`)
  try {
    const event = { eventId: uuid(), eventType: 'user.kyc_updated', eventVersion: 1,
      occurredAt: new Date().toISOString(), data: { authUserId: user.id, kycTier: 1, previousTier: 0 } }
    const publish = () => broker(ctx, `ch.publish('finvault.events','user.kyc_updated',
      Buffer.from(${JSON.stringify(JSON.stringify(event))}),{persistent:true,messageId:'${event.eventId}'});await ch.waitForConfirms();`)
    const count = () => Number(sql(ctx, 'wallet_service', 'SELECT count(*) FROM acceptance_t1.kyc_updates'))
    publish()
    await until(() => count() >= 1, 'S10: Wallet did not consume first KYC event')
    assert.equal(walletTier(ctx, user), '1')
    publish()
    // Broker accounting includes unacknowledged deliveries; wait for processing,
    // not just publisher confirms or an empty ready queue.
    await until(() => {
      const queues = JSON.parse(docker(ctx, 'exec', '-T', 'rabbitmq', 'rabbitmqctl', '-q',
        'list_queues', 'name', 'messages', 'consumers', '--formatter', 'json'))
      const queue = queues.find(row => row.name === 'wallet-service.kyc-updated')
      return queue && Number(queue.consumers) > 0 && Number(queue.messages) === 0
    }, 'S10: Wallet KYC queue did not drain')
    const updates = count()
    evidence(ctx, 'S10', { deliveries: 2, distinctEventIds: 1, updates, walletTier: Number(walletTier(ctx, user)) })
    assert.equal(updates, 1, 'Same eventId must update Wallet exactly once (duplicate UPDATE detected)')
    assert.equal(walletTier(ctx, user), '1')
  } finally {
    sql(ctx, 'wallet_service', `DROP TRIGGER acceptance_t1_kyc ON "Wallet";
      DROP FUNCTION acceptance_t1.record_update(); DROP TABLE acceptance_t1.kyc_updates; DROP SCHEMA acceptance_t1;`)
  }
}
