const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')

test('transaction signing fails closed, binds claims and expires after 60 seconds', () => {
  const env = { ...process.env }
  for (const name of ['AUTH_TXN_PRIVATE_KEY', 'AUTH_TXN_PUBLIC_KEY', 'AUTH_TXN_PRIVATE_KEY_FILE', 'AUTH_TXN_PUBLIC_KEY_FILE']) delete env[name]
  const script = `
    const assert=require('node:assert/strict');const crypto=require('node:crypto');
    const t=require('./src/utils/transactionToken');
    assert.throws(t.getAuthTxnPrivateKey,/required key/);
    const pair=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1',privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
    process.env.AUTH_TXN_PRIVATE_KEY=pair.privateKey;process.env.AUTH_TXN_PUBLIC_KEY=pair.publicKey;
    t.validateTransactionKeys();
    const token=t.signTransactionToken('subject','payment','50000');const data=t.verifyTransactionToken(token);
    assert.equal(data.sub,'subject');assert.equal(data.paymentId,'payment');assert.equal(data.amount,'50000');
    assert.equal(data.exp-data.iat,60);assert.ok(data.jti);
    const realNow=Date.now;Date.now=()=>realNow()+65000;
    try{assert.throws(()=>t.verifyTransactionToken(token),e=>e.code==='TRANSACTION_TOKEN_EXPIRED')}finally{Date.now=realNow}
    process.env.AUTH_TXN_PRIVATE_KEY_FILE='missing-acceptance-key';
    assert.throws(t.getAuthTxnPrivateKey,/Cannot read required key/);
    delete process.env.AUTH_TXN_PRIVATE_KEY_FILE;
    process.env.AUTH_TXN_PUBLIC_KEY=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'pem'});
    assert.throws(t.validateTransactionKeys,/do not match/);
  `
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: resolve(__dirname, '../../services/auth-service'), env, windowsHide: true, encoding: 'utf8'
  })
  // Do not echo assertion internals, tokens or PEMs on failure.
  assert.equal(result.status, 0, 'Transaction-key security regression failed')
})
