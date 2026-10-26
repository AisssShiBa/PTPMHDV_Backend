// Synthetic additive fixtures against the main Compose topology. Never reset volumes.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const root = new URL('../../', import.meta.url)
const config = { ...parseEnv(readFileSync(new URL('.env', root), 'utf8')), ...process.env }
const project = process.env.COMPOSE_PROJECT_NAME || 'finvault-full-check'
assert.match(project, /^finvault-(full-check|huu-check)$/)
const base = 'http://127.0.0.1:' + (config.GATEWAY_PORT || 3000)
const require = createRequire(new URL('services/user-service/package.json', root))
const evidence = []
function docker(...args) {
  return execFileSync('docker', ['compose', '-p', project, ...args],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
function sql(database, statement) {
  return docker('exec', '-T', 'postgres', 'psql', '-U', config.POSTGRES_USER || 'postgres',
    '-d', database, '-At', '-v', 'ON_ERROR_STOP=1', '-c', statement)
}
async function call(path, { method = 'GET', body, token, expected = 200 } = {}) {
  const form = body instanceof FormData
  const response = await fetch(base + path, { method, headers: {
    ...(token ? { authorization: 'Bearer ' + token } : {}),
    ...(body && !form ? { 'content-type': 'application/json' } : {})
  }, body: body ? (form ? body : JSON.stringify(body)) : undefined, signal: AbortSignal.timeout(15000) })
  const result = await response.json()
  // Do not persist query values, identity documents, tokens or signed URLs.
  evidence.push({ method, path: path.split('?')[0], status: response.status, code: result.error?.code })
  assert.equal(response.status, expected, `${method} ${path.split('?')[0]}: ${JSON.stringify(result.error)}`)
  return result
}
const password = 'Synthetic-' + randomUUID()
async function account(role = 'USER') {
  const username = 'huu_' + randomUUID().replaceAll('-', '')
  const email = username + '@example.test'
  const created = await call('/api/auth/signup', { method: 'POST', expected: 201,
    body: { username, password, email, firstName: 'Synthetic', lastName: 'Fixture' } })
  const id = created.data.userId
  assert.match(id, /^[0-9a-f-]{36}$/)
  if (role === 'ADMIN') sql('auth_service', `UPDATE "User" SET role='ADMIN' WHERE id='${id}'`)
  const login = await call('/api/auth/signin', { method: 'POST', body: { username, password } })
  return { id, email, token: login.data.accessToken }
}
function broker(code) {
  return docker('exec', '-T', 'user-publisher', 'node', '-e',
    `const amqp=require('amqplib');(async()=>{const c=await amqp.connect(process.env.RABBITMQ_URL);try{const ch=await c.createChannel();${code}}finally{await c.close()}})().catch(()=>process.exit(1))`)
}
for (const service of ['gateway', 'auth-service', 'user-service', 'admin-service', 'merchant-service',
  'wallet-service', 'payment-service', 'notification-service']) {
  assert.equal(docker('exec', '-T', service, 'node', '-e',
    "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exit(1);console.log('ok')}).catch(()=>process.exit(1))"), 'ok')
}
for (const service of ['auth-service', 'admin-service', 'user-service']) {
  assert.equal(docker('exec', '-T', service, 'node', '-e',
    "const fs=require('fs');if(!fs.readFileSync(process.env.INTERNAL_KEY_FILE,'utf8').trim()||!fs.readFileSync(process.env.GATEWAY_PUBLIC_KEY_FILE,'utf8').trim())process.exit(1);console.log('ok')"), 'ok')
}
const owner = await account(), recipient = await account(), admin = await account('ADMIN')
const profile = (await call('/api/users/me', { token: owner.token })).data
await call('/api/users/by-auth/' + recipient.id, { token: recipient.token, method: 'PUT', body: { fullName: 'Nguyễn Văn Bình' } })
const lookupPath = '/api/users/lookup?q=' + encodeURIComponent(recipient.email)
const found = await call(lookupPath, { token: owner.token })
assert.deepEqual(found.data, { authUserId: recipient.id, maskedName: 'Nguyễn V. B.' })
const missing = await call('/api/users/lookup?q=missing', { token: owner.token, expected: 404 })
const self = await call('/api/users/lookup?q=' + encodeURIComponent(owner.email), { token: owner.token, expected: 404 })
assert.deepEqual(self.error, missing.error)
for (let i = 0; i < 7; i++) await call(lookupPath, { token: owner.token })
await call(lookupPath, { token: owner.token, expected: 429 })

const png = await require('sharp')({ create: { width: 16, height: 16, channels: 3, background: '#ddd' } }).png().toBuffer()
function documents(two = true) {
  const form = new FormData()
  form.set('idNumber', '000000001234')
  form.set('front', new Blob([png], { type: 'image/png' }), 'synthetic-front.png')
  if (two) form.set('back', new Blob([png], { type: 'image/png' }), 'synthetic-back.png')
  return form
}
await call('/api/users/kyc/documents', { method: 'POST', token: owner.token, body: documents(false), expected: 400 })
const upload = await call('/api/users/kyc/documents', { method: 'POST', token: owner.token, body: documents(), expected: 202 })
assert.equal(upload.data.kycStatus, 'PENDING')
assert.equal(upload.data.kycBackObjectKey, undefined)
const path = '/api/admin/kyc/' + profile.id
await call(path + '/documents', { token: recipient.token, expected: 403 })
await call('/api/users/' + profile.id + '/kyc/documents', { token: admin.token, expected: 403 })
await call('/api/users/' + profile.id + '/kyc/document', { token: admin.token, expected: 403 })
for (let i = 0; i < 2; i++) {
  const urls = (await call(path + '/documents', { token: admin.token })).data
  for (const url of [urls.frontUrl, urls.backUrl]) {
    assert.equal(new URL(url).searchParams.get('X-Amz-Expires'), '300')
    assert.equal((await fetch(url)).status, 200)
    const unsigned = new URL(url); unsigned.search = ''
    assert.equal((await fetch(unsigned)).status, 403)
  }
}
const queue = 'huu-smoke-' + randomUUID()
broker(`await ch.assertExchange('finvault.events','topic',{durable:true});await ch.assertQueue('${queue}',{durable:false,arguments:{'x-expires':300000}});await ch.bindQueue('${queue}','finvault.events','user.kyc_updated');`)
try {
  assert.equal((await call(path + '/review', { method: 'POST', token: admin.token, body: { status: 'APPROVED' } })).data.kycTier, 1)
  assert.equal((await call(path + '/tier', { method: 'PATCH', token: admin.token, body: { tier: 2, reason: 'Synthetic bank link' } })).data.kycTier, 2)
  assert.equal((await call(path + '/review', { method: 'POST', token: admin.token, body: { status: 'REJECTED' } })).data.kycTier, 0)
  let published = false
  for (let i = 0; i < 40; i++) {
    published = sql('user_service', `SELECT count(*) FROM user_outbox_events WHERE aggregate_id='${profile.id}' AND status='PUBLISHED'`) === '3'
    if (published) break
    await delay(250)
  }
  assert.ok(published, 'Three tier transitions must be confirmed by the broker')
  const events = JSON.parse(broker(`const events=[];let m;while(m=await ch.get('${queue}',{noAck:true})){const e=JSON.parse(m.content.toString());if(e.data.authUserId==='${owner.id}')events.push(e)}console.log(JSON.stringify(events));`))
  assert.deepEqual(events.map(e => [e.data.previousTier, e.data.kycTier]), [[0, 1], [1, 2], [2, 0]])
  assert.equal(new Set(events.map(e => e.eventId)).size, 3)
  assert.ok(events.every(e => e.eventType === 'user.kyc_updated' && e.eventVersion === 1))
} finally { broker(`await ch.deleteQueue('${queue}');`) }
assert.equal(sql('admin_service', `SELECT count(*) FROM "AdminAuditLog" WHERE "targetId"='${profile.id}' AND action='VIEW_KYC_DOCUMENTS'`), '2')
assert.equal(sql('admin_service', `SELECT count(*) FROM "AdminAuditLog" WHERE "targetId"='${profile.id}' AND action IN ('APPROVE_KYC','UPDATE_KYC_TIER','REJECT_KYC')`), '3')
evidence.push({ check: 'H7-H8-H11', publisherConfirmed: true, auditViews: 2, auditTierChanges: 3,
  twoPrivateImages: true, lookupRateLimited: true, secretsMounted: true, healthyApis: 8 })
mkdirSync(new URL('.cache/deployment/', root), { recursive: true })
writeFileSync(new URL('.cache/deployment/huu-smoke-result.json', root), JSON.stringify({ project, testedAt: new Date().toISOString(), evidence }, null, 2))
console.log('PASS: 8 API health checks, secret mounts, Gateway lookup/S13, two-face upload/S12 authorization, private URLs, Admin audit and three confirmed H7 tier events.')
