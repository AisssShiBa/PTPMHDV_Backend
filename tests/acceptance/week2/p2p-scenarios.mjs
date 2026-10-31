import assert from 'node:assert/strict'
import { account, call, sql, docker, command, uuid, until } from './runtime.mjs'

const pin = '741852'
export async function setupPin(ctx, user) {
  if (user.hasPin) return
  await call(ctx, '/auth/pin/setup', { method: 'POST', token: user.token, expected: 201,
    body: { pin, confirmPin: pin } })
  user.hasPin = true
}
export async function checkout(ctx, sender, receiver, amount, key = uuid(), expected = 201) {
  return call(ctx, '/payments/checkout', { method: 'POST', token: sender.token, expected,
    headers: { 'Idempotency-Key': key }, body: { type: 'WALLET_TRANSFER', destinationUserId: receiver.id, amount: String(amount) } })
}
export async function tokenFor(ctx, sender, payment, amount = payment.amount) {
  await setupPin(ctx, sender)
  return (await call(ctx, '/auth/pin/verify', { method: 'POST', token: sender.token,
    body: { pin, paymentId: payment.id, amount: String(amount) } })).data.transactionToken
}
export async function confirm(ctx, sender, payment, token, expected = 200) {
  return call(ctx, '/payments/' + payment.id + '/confirm', { method: 'POST', token: sender.token, expected,
    body: { transactionToken: token || await tokenFor(ctx, sender, payment) } })
}
export async function transfer(ctx, sender, receiver, amount) {
  const payment = (await checkout(ctx, sender, receiver, amount)).data
  const result = await confirm(ctx, sender, payment)
  assert.equal(result.data.status, 'SUCCESS')
  return result.data
}
const cancel = (ctx, user, payment) => call(ctx, '/payments/' + payment.id + '/cancel', { method: 'POST', token: user.token })
async function funded(ctx, accounts, label, amount = '1100000') {
  const user = await account(ctx, label)
  await call(ctx, '/wallets/' + user.id + '/credit', { method: 'POST', token: accounts.admin.token,
    body: { amount, referenceId: uuid(), transferType: 'TOPUP' } })
  return user
}
const state = (ctx, user) => JSON.stringify(JSON.parse(sql(ctx, 'wallet_service', `SELECT json_build_object('balance', balance, 'held', "heldBalance",
  'usage',(SELECT COALESCE(sum("spentDay"),0) FROM "UserDailyUsage" WHERE "userId"='${user.id}'),
  'ledger',(SELECT count(*) FROM "LedgerEntry" WHERE "walletId"=w.id)) FROM "Wallet" w WHERE "userId"='${user.id}' AND "ownerType"='USER'`)))

export async function a4(ctx, a) {
  // Exercise main's P2P route/header contract alongside Huu's generic/body API.
  const payment = (await call(ctx, '/payments/p2p/checkout', { method: 'POST', token: a.an.token, expected: 201,
    headers: { 'Idempotency-Key': uuid() }, body: { destinationUserId: a.binh.id, amount: '1000' } })).data
  const token = await tokenFor(ctx, a.an, payment)
  const confirmed = await call(ctx, '/payments/' + payment.id + '/confirm', { method: 'POST', token: a.an.token,
    headers: { 'X-Transaction-Token': token }, body: {} })
  assert.equal(confirmed.data.status, 'SUCCESS')
  assert.equal((await confirm(ctx, a.an, payment, token, 409)).error.code, 'TXN_TOKEN_REUSED')
  assert.equal(sql(ctx, 'wallet_service', `SELECT count(*) FROM "LedgerEntry" WHERE "referenceId"='${payment.holdId}'`), '2')
  const expiring = (await checkout(ctx, a.an, a.binh, '1000')).data
  // A separate signer process uses a fake clock; no runtime test endpoint or key leakage.
  const expired = docker(ctx, 'exec', '-T', 'auth-service', 'node', '--import', 'tsx', '-e',
    `const {signTransactionToken}=require('./src/utils/transactionToken');Date.now=()=>${Date.now()-65000};console.log(signTransactionToken('${a.an.id}','${expiring.id}','1000'))`)
  const before = state(ctx, a.an)
  assert.equal((await confirm(ctx, a.an, expiring, expired, 401)).error.code, 'TXN_TOKEN_EXPIRED')
  assert.equal(state(ctx, a.an), before)
  await cancel(ctx, a.an, expiring)
}
export async function s4(ctx, a) {
  const own = (await checkout(ctx, a.an, a.binh, '1000')).data
  const other = (await checkout(ctx, a.binh, a.an, '1000')).data
  const before = state(ctx, a.binh)
  assert.equal((await confirm(ctx, a.an, other, await tokenFor(ctx, a.an, own), 403)).error.code, 'TXN_TOKEN_MISMATCH')
  assert.equal(state(ctx, a.binh), before)
  await cancel(ctx, a.an, own); await cancel(ctx, a.binh, other)
}
export async function s5(ctx, a) {
  const payment = (await checkout(ctx, a.an, a.binh, '1000')).data
  const before = state(ctx, a.an)
  assert.equal((await confirm(ctx, a.an, payment, await tokenFor(ctx, a.an, payment, '1001'), 403)).error.code, 'TXN_TOKEN_MISMATCH')
  assert.equal(state(ctx, a.an), before)
  await cancel(ctx, a.an, payment)
}
export async function a9(ctx, a) {
  const user = await funded(ctx, a, 'p2p-a9')
  const before = state(ctx, user)
  const rejected = await checkout(ctx, user, a.binh, '600000', uuid(), 422)
  assert.equal(rejected.error.code, 'LIMIT_EXCEEDED'); assert.equal(rejected.error.details.limitType, 'PER_TXN')
  assert.equal(state(ctx, user), before)
  await transfer(ctx, user, a.binh, '200000'); await transfer(ctx, user, a.binh, '200000')
  const afterTwo = state(ctx, user)
  assert.equal((await checkout(ctx, user, a.binh, '200000', uuid(), 422)).error.details.limitType, 'PER_DAY')
  assert.equal(state(ctx, user), afterTwo)
}
export async function s6(ctx, a) {
  const user = await funded(ctx, a, 'p2p-s6')
  const responses = await Promise.all(Array.from({ length: 10 }, () => checkout(ctx, user, a.binh, '100000', uuid(), null)))
  assert.equal(responses.filter(r => r.httpStatus === 201).length, 5)
  assert.equal(responses.filter(r => r.httpStatus === 422 && r.error.details.limitType === 'PER_DAY').length, 5)
  assert.equal(sql(ctx, 'wallet_service', `SELECT sum("spentDay")::int FROM "UserDailyUsage" WHERE "userId"='${user.id}'`), '500000')
  for (const response of responses.filter(r => r.httpStatus === 201)) await cancel(ctx, user, response.data)
  assert.equal(sql(ctx, 'wallet_service', `SELECT sum("spentDay")::int FROM "UserDailyUsage" WHERE "userId"='${user.id}'`), '0')
}
export async function s15(ctx, a) {
  const key = uuid()
  const first = (await checkout(ctx, a.an, a.binh, '1000', key)).data
  const second = (await checkout(ctx, a.an, a.binh, '1000', key)).data
  assert.equal(second.id, first.id); assert.equal(second.replayed, true)
  assert.equal(sql(ctx, 'wallet_service', `SELECT count(*) FROM "WalletHold" WHERE "referenceId"='${first.holdId}'`), '1')
  assert.equal((await checkout(ctx, a.an, a.binh, '1001', key, 422)).error.code, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD')
  await cancel(ctx, a.an, first)
}
export async function s8(ctx, a) {
  const user = await funded(ctx, a, 'p2p-s8')
  const before = state(ctx, user)
  const payment = (await checkout(ctx, user, a.binh, '1000')).data
  const token = await tokenFor(ctx, user, payment)
  try {
    await command(ctx, 's8-stop-wallet', 'docker', [...ctx.composeArgs, 'stop', 'wallet-service'])
    const result = await confirm(ctx, user, payment, token, 503)
    assert.equal(result.error.code, 'PAYMENT_PROCESSING')
  } finally {
    await command(ctx, 's8-start-wallet', 'docker', [...ctx.composeArgs, 'up', '-d', '--no-deps', '--wait', 'wallet-service'])
  }
  await until(() => sql(ctx, 'payment_service', `SELECT status FROM "Payment" WHERE id='${payment.id}'`) === 'FAILED', 'Capture failure did not recover')
  assert.equal(state(ctx, user), before)
  assert.equal(sql(ctx, 'wallet_service', `SELECT status FROM "WalletHold" WHERE "referenceId"='${payment.holdId}'`), 'RELEASED')
}
export async function s16(ctx, a) {
  const payment = (await checkout(ctx, a.an, a.binh, '1000')).data
  const token = await tokenFor(ctx, a.an, payment)
  try {
    await command(ctx, 's16-stop-broker', 'docker', [...ctx.composeArgs, 'stop', 'rabbitmq'])
    assert.equal((await confirm(ctx, a.an, payment, token)).data.status, 'SUCCESS')
    assert.equal(sql(ctx, 'payment_service', `SELECT status FROM "OutboxEvent" WHERE "aggregateId"='${payment.id}'`), 'PENDING')
  } finally {
    await command(ctx, 's16-start-broker', 'docker', [...ctx.composeArgs, 'start', 'rabbitmq'])
  }
  const eventId = sql(ctx, 'payment_service', `SELECT id FROM "OutboxEvent" WHERE "aggregateId"='${payment.id}'`)
  await until(() => sql(ctx, 'notification_service', `SELECT count(*) FROM "Notification" WHERE "eventId"='${eventId}'`) === '2', 'Payment notification did not recover', 90000)
  assert.equal(sql(ctx, 'wallet_service', `SELECT count(*) FROM "LedgerEntry" WHERE "referenceId"='${payment.holdId}'`), '2')
}

export async function realtime(ctx, a) {
  await setupPin(ctx, a.an)
  // Socket.IO listener and genuine HTTP checkout/PIN/confirm run together inside the isolated stack.
  const script = `const assert=require('node:assert/strict');const {io}=require('socket.io-client');
  const sender=${JSON.stringify(a.an.token)},receiver=${JSON.stringify(a.binh.token)};
  async function api(path,token,body,headers={}) {const r=await fetch('http://gateway:3000/api'+path,{method:body?'POST':'GET',
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined});
    const j=await r.json();assert.ok(r.ok,path+' '+r.status);return j.data;}
  (async()=>{let socket;try{const ticket=(await api('/notifications/socket-ticket',receiver)).ticket;
    socket=io('http://gateway:3000',{auth:{token:ticket},transports:['websocket'],reconnection:false,forceNew:true});
    await new Promise((ok,no)=>{socket.once('connect',ok);socket.once('connect_error',no)});
    let good=0;const times=[];
    for(let i=0;i<10;i++){const p=await api('/payments/checkout',sender,{amount:'50000',type:'WALLET_TRANSFER',destinationUserId:'${a.binh.id}'},{'Idempotency-Key':crypto.randomUUID()});
      const t=await api('/auth/pin/verify',sender,{pin:'${pin}',paymentId:p.id,amount:'50000'});
      const seen=new Map();const on=n=>seen.set(n.eventId,Date.now());socket.on('notification:new',on);
      const start=Date.now();const confirmed=await api('/payments/'+p.id+'/confirm',sender,{transactionToken:t.transactionToken});
      const deadline=Date.now()+15000;while(!seen.has(confirmed.eventId)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
      socket.off('notification:new',on);assert.ok(seen.has(confirmed.eventId),'notification timeout');
      const ms=seen.get(confirmed.eventId)-start;times.push(ms);if(ms<=3000)good++;}
    assert.ok(good>=9,'Only '+good+'/10 within 3 seconds');console.log(JSON.stringify({good,times}));
  }finally{socket?.close()}})().catch(()=>process.exit(1));`
  await command(ctx, 'r1-backend', 'docker', [...ctx.composeArgs, 'exec', '-T', 'notification-service', 'node', '-e', script])
}

export async function concurrentConfirm(ctx, a) {
  const payment = (await checkout(ctx, a.an, a.binh, '1000')).data
  const token = await tokenFor(ctx, a.an, payment)
  const replies = await Promise.all([confirm(ctx, a.an, payment, token, null), confirm(ctx, a.an, payment, token, null)])
  assert.equal(replies.filter(r => r.httpStatus === 200 && r.data.status === 'SUCCESS').length, 1)
  assert.equal(replies.filter(r => r.httpStatus === 409 && r.error.code === 'TXN_TOKEN_REUSED').length, 1)
  assert.equal(sql(ctx, 'wallet_service', `SELECT count(*) FROM "LedgerEntry" WHERE "referenceId"='${payment.holdId}'`), '2')
}

export async function ambiguousCapture(ctx, a) {
  const payment = (await checkout(ctx, a.an, a.binh, '1000')).data
  const token = await tokenFor(ctx, a.an, payment)
  const before = JSON.parse(state(ctx, a.an))
  const beforeReceiver = JSON.parse(state(ctx, a.binh))
  // Fault injection only in this test process: real Wallet capture commits, then its response is lost.
  const script = `const assert=require('node:assert/strict');const {P2pService}=require('./src/services/p2p.service');
    const {WalletClient}=require('./src/clients/wallet.client');const {DomainException}=require('./src/utils/domain.exception');
    class LostResponse extends WalletClient {once=true;async captureHold(...args){const result=await super.captureHold(...args);
      if(this.once){this.once=false;throw new DomainException(503,'WALLET_UNAVAILABLE','simulated lost capture response')}return result;}}
    new P2pService(new LostResponse()).confirm('${payment.id}','${a.an.id}',${JSON.stringify(token)})
      .then(p=>{assert.equal(p.status,'SUCCESS');console.log('ok');process.exit(0)}).catch(()=>process.exit(1));`
  assert.equal(docker(ctx, 'exec', '-T', 'payment-service', 'node', '--import', 'tsx', '-e', script), 'ok')
  const after = JSON.parse(state(ctx, a.an)), afterReceiver = JSON.parse(state(ctx, a.binh))
  assert.equal(after.balance, before.balance-1000); assert.equal(afterReceiver.balance, beforeReceiver.balance+1000)
  assert.equal(after.ledger, before.ledger+1); assert.equal(afterReceiver.ledger, beforeReceiver.ledger+1)
  assert.equal(sql(ctx, 'wallet_service', `SELECT count(*) FROM "LedgerEntry" WHERE "referenceId"='${payment.holdId}'`), '2')
}
