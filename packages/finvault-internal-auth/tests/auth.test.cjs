const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { generateKeyPairSync } = require('node:crypto')
const jwt = require('jsonwebtoken')
const auth = require('../dist')
const { DEV_STUB_PRIVATE_KEY } = require('../dist/testing')
const initial = { ...process.env }
const userId = '10000000-0000-4000-8000-000000000001'
afterEach(() => { process.env = { ...initial } })
function configure() {
  process.env.NODE_ENV = 'test'
  delete process.env.GATEWAY_PUBLIC_KEY_FILE
  process.env.GATEWAY_PUBLIC_KEY = auth.DEV_STUB_PUBLIC_KEY
}
function sign(changes = {}, key = DEV_STUB_PRIVATE_KEY) {
  const now = Math.floor(Date.now() / 1000)
  return jwt.sign({ iss: 'finvault-gateway', aud: 'finvault-internal-services', sub: userId,
    role: 'USER', kycTier: 0, jti: 'test-id', iat: now, exp: now + 60, ...changes }, key, { algorithm: 'ES256' })
}
test('compiled package verifies identity and rejects malformed, expired and misdirected claims', () => {
  configure()
  assert.equal(auth.verifyGatewayToken(sign()).userId, userId)
  const now = Math.floor(Date.now() / 1000)
  for (const change of [{ iss:'other' }, { aud:'other' }, { sub:undefined }, { sub:'not-uuid' },
    { role:'ROOT' }, { role:undefined }, { kycTier:3 }, { kycTier:'1' }, { kycTier:undefined },
    { jti:'' }, { exp:undefined }, { iat:now-61, exp:now-1 }, { exp:now+61 }, { iat:now+5, exp:now+60 }]) {
    assert.throws(() => auth.verifyGatewayToken(sign(change)), JSON.stringify(change))
  }
  const other = generateKeyPairSync('ec', { namedCurve:'prime256v1' })
  assert.throws(() => auth.verifyGatewayToken(sign({}, other.privateKey)))
})
test('production refuses missing, dev, unreadable and wrong-curve keys', () => {
  configure(); process.env.NODE_ENV='production'
  delete process.env.GATEWAY_PUBLIC_KEY
  assert.throws(auth.getGatewayPublicKey, /required/)
  process.env.GATEWAY_PUBLIC_KEY=auth.DEV_STUB_PUBLIC_KEY
  assert.throws(auth.getGatewayPublicKey, /Development/)
  const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'})
  process.env.GATEWAY_PUBLIC_KEY=pair.publicKey.export({type:'spki',format:'pem'})
  assert.equal(auth.verifyGatewayToken(sign({},pair.privateKey)).userId,userId)
  assert.throws(() => auth.createTestGatewayToken(userId), /disabled/)
  process.env.GATEWAY_PUBLIC_KEY_FILE='missing-gateway-key.pem'
  assert.throws(auth.getGatewayPublicKey)
  delete process.env.GATEWAY_PUBLIC_KEY_FILE
  process.env.GATEWAY_PUBLIC_KEY=generateKeyPairSync('ec',{namedCurve:'secp384r1'}).publicKey.export({type:'spki',format:'pem'})
  assert.throws(auth.getGatewayPublicKey,/ES256/)
})
test('middleware clears stale identity and preserves correlation on auth failures', () => {
  configure()
  const req={headers:{'x-gateway-verified':'true'},requestId:'request-1',auth:{role:'ADMIN'}}
  const res={status(code){this.code=code;return this},json(body){this.body=body;return this},getHeader(){}}
  auth.requireGateway(req,res,()=>assert.fail('must reject'))
  assert.equal(res.code,401); assert.equal(req.auth,undefined)
  assert.equal(res.body.requestId,'request-1')
  req.headers['x-gateway-token']=sign()
  let called=false
  auth.requireGateway(req,res,()=>{called=true})
  assert.ok(called); assert.equal(req.auth.userId,userId)
  auth.requireRole('ADMIN')(req,res,()=>assert.fail('must reject USER'))
  assert.equal(res.code,403)
})
