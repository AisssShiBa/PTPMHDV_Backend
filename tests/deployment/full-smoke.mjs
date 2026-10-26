// Additive fixtures only, against the dedicated project created from the main Compose file.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const root = new URL('../../', import.meta.url)
const config = parseEnv(readFileSync(new URL('.env', root), 'utf8'))
const require = createRequire(new URL('services/user-service/package.json', root))
const sharp = require('sharp')
const project = 'finvault-full-check'
const base = 'http://127.0.0.1:' + (config.GATEWAY_PORT || 3000)
const evidence = []
function docker(...args) {
  return execFileSync('docker', ['compose', '-p', project, ...args],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
function sql(database, statement) {
  return docker('exec', '-T', 'postgres', 'psql', '-U', config.POSTGRES_USER || 'postgres',
    '-d', database, '-At', '-v', 'ON_ERROR_STOP=1', '-c', statement)
}
async function call(path, { method = 'GET', body, token, cookie, headers = {}, expected = 200 } = {}) {
  const form = body instanceof FormData
  const response = await fetch(base + path, { method, headers: {
    ...(token ? { authorization: 'Bearer ' + token } : {}), ...(cookie ? { cookie } : {}),
    ...(body && !form ? { 'content-type': 'application/json' } : {}), ...headers
  }, body: body ? (form ? body : JSON.stringify(body)) : undefined, signal: AbortSignal.timeout(15000) })
  const value = await response.json()
  evidence.push({ method, path, status: response.status, code: value.error?.code })
  assert.equal(response.status, expected, method + ' ' + path + ': ' + JSON.stringify(value.error))
  return { value, cookie: response.headers.get('set-cookie')?.split(';')[0], rawCookie: response.headers.get('set-cookie') }
}
async function until(check) {
  for (let i = 0; i < 60; i++) { if (await check()) return; await delay(500) }
  throw new Error('Event processing timed out')
}
const gatewayId = docker('ps', '-q', 'gateway')
assert.ok(gatewayId, 'Start the finvault-full-check project first')
for (const service of ['gateway', 'auth-service', 'user-service', 'merchant-service', 'wallet-service',
  'payment-service', 'notification-service', 'admin-service']) {
  const result = docker('exec', '-T', service, 'node', '-e',
    "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(async r=>{if(!r.ok)throw Error('health');console.log((await r.json()).status)}).catch(()=>process.exit(1))")
  assert.equal(result, 'ok')
  evidence.push({ check: 'health', service, status: 'ok' })
}
const password = 'Smoke-' + randomUUID()
async function signup() {
  const username = 'smoke_' + randomUUID().replaceAll('-', '')
  const { value } = await call('/api/auth/signup', { method: 'POST', expected: 201,
    body: { username, password, email: username + '@example.test', firstName: 'Smoke', lastName: 'Fixture' } })
  assert.match(value.data.userId, /^[0-9a-f-]{36}$/)
  return { username, id: value.data.userId }
}
const owner = await signup()
const admin = await signup()
sql('auth_service', `UPDATE "User" SET role='ADMIN' WHERE id='${admin.id}'`)
const web = await call('/api/auth/signin', { method: 'POST', body: { username: owner.username, password } })
assert.match(web.rawCookie, /HttpOnly/i)
assert.equal(web.value.data.refreshToken, undefined)
await call('/api/auth/refresh', { method: 'POST', cookie: web.cookie, body: {} })
const mobile = await call('/api/auth/signin', { method: 'POST', headers: { 'x-client-platform': 'mobile' },
  body: { username: owner.username, password } })
assert.ok(mobile.value.data.refreshToken)
const refreshed = await call('/api/auth/refresh', { method: 'POST', headers: { 'x-client-platform': 'mobile' },
  body: { refreshToken: mobile.value.data.refreshToken } })
assert.ok(refreshed.value.data.refreshToken !== mobile.value.data.refreshToken, 'Mobile refresh token must rotate')
const token = refreshed.value.data.accessToken
const adminLogin = await call('/api/auth/signin', { method: 'POST', body: { username: admin.username, password } })
const adminToken = adminLogin.value.data.accessToken
const profile = (await call('/api/users/me', { token })).value.data
assert.equal(profile.authUserId, owner.id)
await call('/api/wallets/' + owner.id + '/balance', { token })
await call('/api/payments', { token })
await call('/api/notifications/' + owner.id, { token })
await call('/api/notifications/' + admin.id, { token, expected: 403 })
await call('/api/notifications', { method: 'POST', token, expected: 401,
  headers: { 'x-internal-key': config.INTERNAL_KEY }, body: { userId: owner.id, type: 'SYSTEM', message: 'forged' } })
await call('/api/payments/' + randomUUID() + '/refund', { method: 'POST', token, expected: 401 })
for (const path of ['/api/users', '/api/merchants', '/api/admin/kyc']) {
  await call(path, { token, headers: { 'x-internal-key': config.INTERNAL_KEY, 'x-user-role': 'ADMIN' }, expected: 403 })
  await call(path, { headers: { 'x-gateway-verified': 'true' }, expected: 401 })
}
const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#eee' } }).png().toBuffer()
const form = new FormData()
form.set('idNumber', 'SYNTHETIC-SMOKE-ONLY')
form.set('front', new Blob([png], { type: 'image/png' }), 'synthetic-front.png')
form.set('back', new Blob([png], { type: 'image/png' }), 'synthetic-back.png')
await call('/api/users/kyc/documents', { method: 'POST', token, body: form, expected: 202 })
const document = (await call('/api/users/by-auth/' + owner.id + '/kyc/document', { token })).value.data
assert.equal((await fetch(document.url)).status, 200)
const unsigned = new URL(document.url); unsigned.search = ''
assert.equal((await fetch(unsigned)).status, 403)
await call('/api/admin/kyc/' + profile.id + '/status', { method: 'PATCH', token: adminToken, body: { status: 'APPROVED' } })
assert.equal((await call('/api/users/me/kyc', { token })).value.data.kycStatus, 'APPROVED')
const merchant = (await call('/api/merchants/register', { method: 'POST', token, expected: 201,
  body: { businessName: 'Smoke ' + owner.id } })).value.data
assert.match(merchant.id, /^[0-9a-f-]{36}$/)
await call('/api/merchants/' + merchant.id, { method: 'PUT', token, body: { businessName: 'Updated ' + owner.id } })
await call('/api/admin/merchants/' + merchant.id + '/status', { method: 'PATCH', token: adminToken, body: { status: 'APPROVED' } })
assert.equal((await call('/api/merchants/me', { token })).value.data.status, 'APPROVED')
await until(() => sql('merchant_service', `SELECT count(*) FROM merchant_outbox_events WHERE aggregate_id='${merchant.id}' AND status='PUBLISHED'`) === '3')
const event = { eventId: randomUUID(), eventType: 'user.registered', eventVersion: 1, occurredAt: new Date().toISOString(),
  data: { authUserId: randomUUID(), email: randomUUID() + '@example.test' } }
docker('exec', '-T', 'merchant-service', 'node', '-e',
  `const amqp=require('amqplib');(async()=>{const c=await amqp.connect(process.env.RABBITMQ_URL);try{const ch=await c.createConfirmChannel();const event=${JSON.stringify(event)};for(let i=0;i<2;i++)ch.publish('finvault.events','user.registered',Buffer.from(JSON.stringify(event)),{persistent:true});await ch.waitForConfirms()}finally{await c.close()}})().catch(()=>process.exit(1))`)
await until(() => sql('user_service', `SELECT count(*) FROM consumed_events WHERE id='${event.eventId}'`) === '1')
assert.equal(sql('user_service', `SELECT count(*) FROM users WHERE auth_user_id='${event.data.authUserId}'`), '1')
evidence.push({ check: 'real-infrastructure', privateKyc: true, adminReview: true, merchantPublishedEvents: 3, deduplicatedRegistration: true })
mkdirSync(new URL('.cache/deployment/', root), { recursive: true })
writeFileSync(new URL('.cache/deployment/full-smoke-result.json', root), JSON.stringify(evidence, null, 2))
console.log('PASS: full Compose health, signup, Web/Mobile refresh, Wallet/Payment/Notification access, RBAC, private KYC, Admin review, Merchant publisher and registration consumer.')
