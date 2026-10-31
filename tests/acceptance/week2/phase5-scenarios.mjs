import { a4, a9, s4, s5, s6, s8, s15, s16, realtime, concurrentConfirm, ambiguousCapture } from './p2p-scenarios.mjs'
import assert from 'node:assert/strict'
import { account, call, sql, docker, command, uuid } from './runtime.mjs'
import { s11, s12, s13, k1, conservation, Blocked } from './scenarios.mjs'
import { walletA9, walletS6, s7, inlineExpiry, s10 } from './wallet-scenarios.mjs'
import { realtimeUI } from './realtime-ui.mjs'

const balance = async (ctx, user) => (await call(ctx, '/wallets/' + user.id + '/balance', { token: user.token })).data
const ledgerCount = ctx => sql(ctx, 'wallet_service', 'SELECT count(*) FROM "LedgerEntry"')

async function s1(ctx, a) {
  const before = [await balance(ctx, a.an), await balance(ctx, a.binh), ledgerCount(ctx)]
  for (const headers of [{}, { 'x-user-role': 'ADMIN', 'x-internal-key': ctx.config.INTERNAL_KEY }]) {
    const result = await call(ctx, '/wallets/' + a.an.id + '/transfer', { method: 'POST', token: a.an.token,
      headers, expected: 403, body: { toUserId: a.binh.id, amount: '50000', referenceId: uuid() } })
    assert.equal(result.error.code, 'FORBIDDEN')
  }
  assert.deepEqual([await balance(ctx, a.an), await balance(ctx, a.binh), ledgerCount(ctx)], before)
}
async function s2(ctx, a) {
  const before = [await balance(ctx, a.an), ledgerCount(ctx)]
  for (const route of ['hold', 'capture', 'release', 'credit', 'debit']) {
    const result = await call(ctx, '/wallets/' + a.an.id + '/' + route, { method: 'POST', token: a.an.token,
      expected: 403, body: { amount: '50000', referenceId: uuid(),
        expiresAt: new Date(Date.now() + 60000).toISOString(), destinationUserId: a.binh.id } })
    assert.equal(result.error.code, 'FORBIDDEN')
  }
  assert.deepEqual([await balance(ctx, a.an), ledgerCount(ctx)], before)
}
async function s3(ctx, a) {
  // A minimal persisted payment fixture isolates authorization from the missing
  // week-2 checkout/hold integration. No successful payment is fabricated.
  const id = uuid(), key = uuid()
  sql(ctx, 'payment_service', `INSERT INTO "Payment"
    (id,"userId",amount,type,"referenceId","callbackTopic","idempotencyKey","requestHash",
     "idempotencyStatus","idempotencyExpiresAt",status,"updatedAt") VALUES
    ('${id}','${a.binh.id}',50000,'WALLET_TRANSFER','${uuid()}','acceptance.fixture','${key}',
     'acceptance-authorization-fixture','COMPLETED',NOW()+INTERVAL '1 day','PENDING',NOW())`)
  await call(ctx, '/payments/' + id, { token: a.binh.token })
  for (const method of ['GET', 'POST']) {
    const result = await call(ctx, '/payments/' + id + (method === 'POST' ? '/cancel' : ''), {
      method, token: a.an.token, expected: 403,
      headers: { 'x-user-id': a.binh.id, 'x-user-role': 'ADMIN' }
    })
    assert.equal(result.error.code, 'FORBIDDEN')
  }
  assert.equal(sql(ctx, 'payment_service', `SELECT status FROM "Payment" WHERE id='${id}'`), 'PENDING')
  assert.equal(sql(ctx, 'payment_service', `SELECT count(*) FROM "PaymentHistory" WHERE "paymentId"='${id}'`), '0')
  const list = await call(ctx, '/payments?userId=' + a.binh.id, { token: a.an.token })
  assert.ok(list.data.every(payment => payment.userId === a.an.id))
  await call(ctx, '/payments/' + id + '/cancel', { method: 'POST', token: a.binh.token })
  assert.equal(sql(ctx, 'payment_service', `SELECT status FROM "Payment" WHERE id='${id}'`), 'CANCELLED')
}
async function a3(ctx) {
  const user = await account(ctx, 'a3'), paymentId = uuid()
  const correct = '741852', wrong = '963258'
  await call(ctx, '/auth/pin/setup', { method: 'POST', token: user.token, expected: 201,
    body: { pin: correct, confirmPin: correct } })
  for (let i = 0; i < 4; i++) {
    const result = await call(ctx, '/auth/pin/verify', { method: 'POST', token: user.token, expected: 400,
      body: { pin: wrong, paymentId, amount: '50000' } })
    assert.equal(result.error.code, 'INVALID_PIN')
  }
  const locked = await call(ctx, '/auth/pin/verify', { method: 'POST', token: user.token, expected: 423,
    body: { pin: wrong, paymentId, amount: '50000' } })
  assert.equal(locked.error.code, 'PIN_LOCKED')
  assert.ok(Date.parse(locked.error.details.lockedUntil) > Date.now() + 29 * 60000)
  const sixth = await call(ctx, '/auth/pin/verify', { method: 'POST', token: user.token, expected: 423,
    body: { pin: correct, paymentId, amount: '50000' } })
  assert.equal(sixth.error.code, 'PIN_LOCKED')
  assert.equal(sixth.error.details.lockedUntil, locked.error.details.lockedUntil)
  // Fake Date only in a separate process calling the real PinService + real DB.
  // No runtime test clock endpoint and no SQL edit to the lock timestamp.
  assert.equal(docker(ctx, 'exec', '-T', 'auth-service', 'node', '--import', 'tsx', '-e', `
    const assert=require('node:assert/strict');
    const {PinService}=require('./src/services/pinService');const {prisma}=require('./src/config/prisma');
    const RealDate=Date;const now=Date.parse('${locked.error.details.lockedUntil}')+1;
    global.Date=class extends RealDate { constructor(...args){super(...(args.length?args:[now]))} static now(){return now} };
    (async()=>{try{const r=await PinService.verifyPin('${user.id}',{pin:'${correct}',paymentId:'${paymentId}',amount:'50000'});
      assert.ok(r.transactionToken);assert.equal(r.expiresIn,60);
      const p=await prisma.userPin.findUniqueOrThrow({where:{userId:'${user.id}'}});
      assert.equal(p.failedAttempts,0);assert.equal(p.lockedUntil,null);console.log('ok');
    }finally{global.Date=RealDate;await prisma.$disconnect()}})().catch(()=>process.exit(1));`), 'ok')
}
async function s9(ctx) {
  try {
    await command(ctx, 's9-stop-wallet', 'docker', [...ctx.composeArgs, 'stop', 'wallet-service'])
    await command(ctx, 's9-two-wallets', 'docker', [...ctx.composeArgs, 'up', '-d', '--no-deps', '--scale',
      'wallet-service=2', '--wait', '--wait-timeout', '120', 'wallet-service'])
    assert.equal(docker(ctx, 'ps', '--status', 'running', '-q', 'wallet-service').split(/\r?\n/).filter(Boolean).length, 2)
    assert.equal(sql(ctx, 'wallet_service', `SELECT string_agg("systemCode"::text || ':' || n, ',' ORDER BY "systemCode"::text)
      FROM (SELECT "systemCode",count(*)::text n FROM "Wallet" WHERE "ownerType"='SYSTEM' GROUP BY "systemCode") counts`),
      'FEE:1,MAIN:1,TOPUP_POOL:1')
    await conservation(ctx)
  } finally {
    await command(ctx, 's9-restore-wallet', 'docker', [...ctx.composeArgs, 'up', '-d', '--no-deps', '--scale',
      'wallet-service=1', '--wait', '--wait-timeout', '120', 'wallet-service'])
  }
}
async function s14(ctx, a) {
  const ticket = (await call(ctx, '/notifications/socket-ticket', { token: a.binh.token })).data.ticket
  const fresh = (await call(ctx, '/notifications/socket-ticket', { token: a.binh.token })).data.ticket
  assert.notEqual(ticket, fresh)
  assert.equal(docker(ctx, 'exec', '-T', 'notification-service', 'node', '-e', `
    const assert=require('node:assert/strict');const {io}=require('socket.io-client');
    function open(token){return new Promise((resolve,reject)=>{const socket=io('http://gateway:3000',{
      auth:{token},transports:['polling'],forceNew:true,reconnection:false,timeout:5000});
      socket.once('connect',()=>resolve(socket));socket.once('connect_error',e=>{socket.close();reject(e)})})}
    (async()=>{let a,b;try{a=await open(${JSON.stringify(ticket)});
      await assert.rejects(open(${JSON.stringify(ticket)}),e=>e.message==='INVALID_GATEWAY_TOKEN');
      b=await open(${JSON.stringify(fresh)});console.log('ok');
    }finally{a?.close();b?.close()}})().catch(()=>process.exit(1));`), 'ok')
}

export const phase5Scenarios = [
  ['A3', 'Dat', 'Five wrong PINs, lock even with correct PIN, fake-clock unlock', a3],
  ['A4', 'Dat/Khoa', 'Transaction token single-use and 65-second expiry', a4],
  ['A9', 'Khoa', 'Tier-0 transaction/day limits and unchanged rejected usage', a9],
  ['R1', 'Nguyen', 'P2P HTTP confirm to recipient Socket.IO within 3 seconds in at least 9/10 runs', realtime],
  ['K1', 'Huu/Dat/Khoa', 'KYC upgrade through tier-aware P2P transfer', k1],
  ['S1', 'Dat', 'Direct USER transfer denied without ledger mutation', s1],
  ['S2', 'Dat', 'Direct USER hold/capture/release/credit/debit denied', s2],
  ['S3', 'Khoa', 'Payment ownership on read, cancel and list', s3],
  ['S4', 'Khoa', 'Confirm another payment with own token rejected', s4],
  ['S5', 'Dat', 'Changed amount rejected by transaction token binding', s5],
  ['S6', 'Khoa', 'Ten concurrent checkouts do not exceed daily usage', s6],
  ['S7', 'Khoa', 'Release/expired hold restores daily usage', s7],
  ['S8', 'Khoa', 'Wallet capture failure releases hold without crediting sender', s8],
  ['S9', 'Khoa', 'Two real Wallet instances, one wallet per systemCode', s9],
  ['S10', 'Dat', 'Duplicate KYC event updates Wallet once', s10],
  ['S11', 'Huu', 'KYC approve/reject, audit and confirmed events', s11],
  ['S12', 'Huu', 'Private two-face URLs and actual expiration', s12],
  ['S13', 'Huu', 'Exact masked lookup, uniform errors and rate limit', s13],
  ['S14', 'Nguyen', 'Reused socket ticket rejected; fresh ticket accepted', s14],
  ['S15', 'Khoa', 'Idempotency-Key replay returns same payment and one hold', s15],
  ['S16', 'Nguyen/Khoa', 'P2P succeeds with broker off and notification catches up', s16],
  ['P2P-CONCURRENT', 'Huu', 'Concurrent confirmation consumes one token and captures once', concurrentConfirm],
  ['P2P-AMBIGUOUS', 'Huu', 'Lost capture response reconciles without a compensating credit', ambiguousCapture],
  ['WALLET-A9', 'Khoa', 'Wallet component: tier-0 transfer limits preserve rejected state', walletA9],
  ['WALLET-S6', 'Khoa', 'Wallet component: ten concurrent holds respect daily usage', walletS6],
  ['WALLET-S7-INLINE', 'Khoa', 'Inline expired capture commits usage restoration before returning 409', inlineExpiry],
  ['R1-UI', 'Huu/Nguyen', 'Real browser recipient popup within 3 seconds in at least 9/10 transfers', realtimeUI]
]
