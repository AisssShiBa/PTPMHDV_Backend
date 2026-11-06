// Week 3 / H13 outlet + API key + QR module, run against the real HTTP stack
// (Gateway -> merchant-service -> PostgreSQL, plus the real Outbox publisher and
// the real broker). Every verdict below is a response or a durable row observed
// in this run; the QR checks recompute the HMAC from the run's own secret.
import assert from 'node:assert/strict'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { account, call, sql, until } from '../week2/runtime.mjs'

// Read from this run's generated secret file only; never printed or persisted.
function qrSecret(ctx) {
  return readFileSync(resolve(ctx.directory, 'secrets/merchant_qr_secret.txt'), 'utf8').trim()
}

// Independent re-implementation of the documented canonical form so the token
// served over HTTP is checked as data, not against the service's own function.
function verifyQr(ctx, token, expected) {
  if (typeof token !== 'string') return null
  const separator = token.lastIndexOf('.')
  if (separator <= 0) return null
  const body = Buffer.from(token.slice(0, separator), 'base64url').toString('utf8')
  const presented = Buffer.from(token.slice(separator + 1), 'base64url')
  const actual = createHmac('sha256', qrSecret(ctx)).update(body, 'utf8').digest()
  if (presented.length !== actual.length || !timingSafeEqual(presented, actual)) return null
  const fields = body.split('|')
  if (fields.length !== 5) return null
  const [version, merchantId, outletId, outletCode, issuedAt] = fields
  if (Number(version) !== 1 || !Number.isInteger(Number(issuedAt))) return null
  if (expected?.merchantId !== undefined && expected.merchantId !== merchantId) return null
  if (expected?.outletId !== undefined && expected.outletId !== outletId) return null
  return { version: Number(version), merchantId, outletId, outletCode, issuedAt: Number(issuedAt) }
}

export async function seed(ctx, state) {
  state.admin = await account(ctx, 'h13-admin', undefined, 'ADMIN')
  state.ownerA = await account(ctx, 'h13-owner-a')
  state.ownerB = await account(ctx, 'h13-owner-b')
  state.pendingOwner = await account(ctx, 'h13-owner-pending')

  const register = (user, name) => call(ctx, '/merchants/register', {
    method: 'POST', token: user.token, body: { businessName: name }, expected: 201
  })
  const approve = async (merchantId) => call(ctx, '/merchants/' + merchantId + '/status', {
    method: 'PATCH', token: state.admin.token, body: { status: 'APPROVED' }
  })

  state.merchantA = (await register(state.ownerA, 'Acceptance Mart A')).data
  state.merchantB = (await register(state.ownerB, 'Acceptance Mart B')).data
  state.merchantPending = (await register(state.pendingOwner, 'Acceptance Mart Pending')).data
  assert.equal(state.merchantA.status, 'PENDING')
  assert.equal(state.merchantA.ownerId, state.ownerA.id, 'ownerId must be the Auth user id')
  await approve(state.merchantA.id)
  await approve(state.merchantB.id)
  state.merchantA = (await call(ctx, '/merchants/' + state.merchantA.id, { token: state.ownerA.token })).data
  assert.equal(state.merchantA.status, 'APPROVED')
  return { notes: 'ADMIN + 3 USER principals; merchants A/B APPROVED, merchant PENDING' }
}

const postOutlet = (ctx, user, merchantId, body, expected = 201) =>
  call(ctx, '/merchants/' + merchantId + '/outlets', { method: 'POST', token: user.token, body, expected })
const getOutlets = (ctx, user, merchantId, expected = 200) =>
  call(ctx, '/merchants/' + merchantId + '/outlets', { token: user.token, expected })
const getQr = (ctx, user, merchantId, outletId, expected = 200) =>
  call(ctx, '/merchants/' + merchantId + '/outlets/' + outletId + '/qr', { token: user.token, expected })
const createKey = (ctx, user, merchantId, expected = 201) =>
  call(ctx, '/merchants/' + merchantId + '/api-keys', { method: 'POST', token: user.token, expected })
const revokeKey = (ctx, user, merchantId, keyId, expected = 200) =>
  call(ctx, '/merchants/' + merchantId + '/api-keys/' + keyId, { method: 'DELETE', token: user.token, expected })

function merchantRow(ctx, id) {
  const [version, status] = sql(ctx, 'merchant_service',
    "SELECT version, status FROM merchants WHERE id='" + id + "'").split('|')
  return { version: Number(version), status }
}

function outbox(ctx, merchantId) {
  const text = sql(ctx, 'merchant_service',
    "SELECT event_type, aggregate_version, status FROM merchant_outbox_events WHERE aggregate_id='" +
    merchantId + "' ORDER BY aggregate_version")
  return text ? text.split('\n').map(line => {
    const [eventType, version, status] = line.split('|')
    return { eventType, version: Number(version), status }
  }) : []
}

// M01 - an APPROVED owner creates an outlet; the list is scoped to that merchant
// and exactly one outbox event is enqueued at the merchant's new version.
export async function m01(ctx, state) {
  const outlet = (await postOutlet(ctx, state.ownerA, state.merchantA.id,
    { name: 'Counter 1', code: 'M01-COUNTER' })).data
  assert.match(outlet.id, /^[0-9a-f-]{36}$/)
  assert.equal(outlet.merchantId, state.merchantA.id)

  const list = (await getOutlets(ctx, state.ownerA, state.merchantA.id)).data
  assert.equal(list.totalElements, 1)
  assert.equal(list.content[0].id, outlet.id)

  // registered(1) and status_updated(2) precede it, so the outlet's event must be
  // exactly one new profile_updated at the merchant's incremented version.
  const row = merchantRow(ctx, state.merchantA.id)
  await until(() => {
    const own = outbox(ctx, state.merchantA.id)
    return own.at(-1)?.version === row.version
  }, 'Profile event was not enqueued at the merchant version')
  const events = outbox(ctx, state.merchantA.id)
  assert.deepEqual(events.map(event => event.eventType),
    ['merchant.registered', 'merchant.status_updated', 'merchant.profile_updated'])
  assert.deepEqual(events.map(event => event.version), [1, 2, 3])
  assert.equal(row.version, 3)

  state.outletA = outlet
  return { httpStatus: 201,
    notes: 'outlet 201; list totalElements=1; registered/status_updated/profile_updated at versions 1/2/3' }
}

// M02 - a merchant that is not APPROVED cannot expose an outlet, key or QR.
export async function m02(ctx, state) {
  const created = await postOutlet(ctx, state.pendingOwner, state.merchantPending.id,
    { name: 'Blocked counter', code: 'M02-BLOCKED' }, 409)
  assert.equal(created.error.code, 'MERCHANT_NOT_APPROVED')
  const key = await createKey(ctx, state.pendingOwner, state.merchantPending.id, 409)
  assert.equal(key.error.code, 'MERCHANT_NOT_APPROVED')
  // getOutletQr() refuses on merchant status before it resolves the outlet, so a
  // placeholder outletId still answers 409 rather than 404.
  const qr = await getQr(ctx, state.pendingOwner, state.merchantPending.id,
    '00000000-0000-4000-8000-000000000000', 409)
  assert.equal(qr.error.code, 'MERCHANT_NOT_APPROVED')

  assert.equal(Number(sql(ctx, 'merchant_service',
    "SELECT count(*) FROM outlets WHERE merchant_id='" + state.merchantPending.id + "'")), 0)
  return { httpStatus: 409, errorCode: 'MERCHANT_NOT_APPROVED',
    notes: 'PENDING merchant: outlet, api-key and QR all 409; zero outlet rows' }
}

// M03 - ownership isolation on every nested resource; ADMIN passes.
export async function m03(ctx, state) {
  const forged = await getOutlets(ctx, state.ownerB, state.merchantA.id, 403)
  assert.equal(forged.error.code, 'FORBIDDEN')
  await postOutlet(ctx, state.ownerB, state.merchantA.id, { name: 'Nope', code: 'M03-NOPE' }, 403)
  const qr = await getQr(ctx, state.ownerB, state.merchantA.id, state.outletA.id, 403)
  assert.equal(qr.error.code, 'FORBIDDEN')
  const key = (await createKey(ctx, state.ownerA, state.merchantA.id)).data
  await revokeKey(ctx, state.ownerB, state.merchantA.id, key.keyId, 403)

  const adminList = await getOutlets(ctx, state.admin, state.merchantA.id, 200)
  assert.equal(adminList.data.totalElements, 1)
  await call(ctx, '/merchants/' + state.merchantA.id, { token: state.admin.token })

  return { httpStatus: 403, errorCode: 'FORBIDDEN',
    notes: 'foreign USER: list/create/QR/revoke all 403; ADMIN list and read 200' }
}

// M04 - a duplicate outlet code is a safe 409, never a leaked constraint error.
export async function m04(ctx, state) {
  const same = await postOutlet(ctx, state.ownerA, state.merchantA.id,
    { name: 'Duplicate locally', code: 'M01-COUNTER' }, 409)
  assert.equal(same.error.code, 'DUPLICATE_RESOURCE')
  const other = await postOutlet(ctx, state.ownerB, state.merchantB.id,
    { name: 'Duplicate globally', code: 'M01-COUNTER' }, 409)
  assert.equal(other.error.code, 'DUPLICATE_RESOURCE')
  for (const leaked of ['outlets_code_key', 'unique constraint', 'P2002'])
    assert.ok(!JSON.stringify(same).includes(leaked), 'response leaked ' + leaked)

  assert.equal(Number(sql(ctx, 'merchant_service',
    "SELECT count(*) FROM outlets WHERE code='M01-COUNTER'")), 1)
  return { httpStatus: 409, errorCode: 'DUPLICATE_RESOURCE',
    notes: 'same-merchant and cross-merchant duplicate both 409 DUPLICATE_RESOURCE; one row; no constraint name leaked' }
}

// M05 - the served QR verifies, a single mutated byte does not, and merchant
// identity is part of the signed payload.
export async function m05(ctx, state) {
  const qr = (await getQr(ctx, state.ownerA, state.merchantA.id, state.outletA.id)).data
  assert.equal(qr.algorithm, 'HMAC-SHA256')
  assert.equal(qr.version, 1)
  assert.equal(qr.outletCode, 'M01-COUNTER')

  const verified = verifyQr(ctx, qr.token, { merchantId: state.merchantA.id, outletId: state.outletA.id })
  assert.ok(verified, 'the served QR must verify against the run secret')
  assert.deepEqual(verified, {
    version: 1, merchantId: state.merchantA.id, outletId: state.outletA.id,
    outletCode: 'M01-COUNTER', issuedAt: qr.issuedAt
  })

  const separator = qr.token.lastIndexOf('.')
  const body = Buffer.from(qr.token.slice(0, separator), 'base64url').toString('utf8')
  const signature = qr.token.slice(separator + 1)
  const fields = body.split('|')
  fields[3] = fields[3].slice(0, -1) + (fields[3].endsWith('R') ? 'S' : 'R')
  const tampered = Buffer.from(fields.join('|'), 'utf8').toString('base64url') + '.' + signature
  assert.equal(verifyQr(ctx, tampered), null, 'a mutated outlet code must invalidate the QR')
  assert.equal(verifyQr(ctx, qr.token.slice(0, -1)), null, 'a truncated QR must be invalid')

  assert.equal(verifyQr(ctx, qr.token, { merchantId: state.merchantB.id }), null,
    'merchant B must not accept merchant A\'s QR')
  const cross = await getQr(ctx, state.ownerB, state.merchantB.id, state.outletA.id, 404)
  assert.equal(cross.error.code, 'NOT_FOUND')
  return { httpStatus: 200,
    notes: 'served QR verifies; mutated code, truncated token and other-merchant binding all invalid; outlet from A under B is 404' }
}

// M06 - the API key secret exists only in the creation response; the database
// stores its SHA-256 and nothing returns it again.
export async function m06(ctx, state) {
  const created = await createKey(ctx, state.ownerA, state.merchantA.id)
  assert.equal(created.headers.get('cache-control'), 'no-store')
  const data = created.data
  assert.equal(typeof data.key, 'string')
  const point = data.key.indexOf('.')
  assert.ok(point > 0)
  assert.equal(data.key.slice(0, point), data.keyId)
  const secret = data.key.slice(point + 1)
  assert.ok(secret.length >= 32, 'secret must be at least 32 characters')
  assert.ok(!JSON.stringify(data).includes('secretHash'))

  const stored = sql(ctx, 'merchant_service',
    "SELECT secret_hash, prefix FROM merchant_api_keys WHERE key_id='" + data.keyId + "'").split('|')
  assert.equal(stored[0], createHash('sha256').update(secret, 'utf8').digest('hex'))
  assert.equal(stored[1], secret.slice(0, 8))
  const raw = sql(ctx, 'merchant_service',
    "SELECT count(*) FROM merchant_api_keys WHERE secret_hash='" + secret + "'")
  assert.equal(Number(raw), 0, 'the raw secret must never be stored')

  const revoked = await revokeKey(ctx, state.ownerA, state.merchantA.id, data.keyId)
  assert.ok(!JSON.stringify(revoked.data).includes(secret))
  assert.ok(!JSON.stringify(revoked.data).includes('secretHash'))

  state.keyM06 = data
  return { httpStatus: 201,
    notes: 'secret only on create; no-store set; DB holds SHA-256(secret) and the 8-char prefix; raw secret absent from DB; revoke response carries neither' }
}

// M07 - revocation is idempotent and never re-exposes the secret; unknown keys 404.
export async function m07(ctx, state) {
  const target = state.keyM06
  const revokedAt = (id) => sql(ctx, 'merchant_service',
    "SELECT COALESCE(revoked_at::text,'') FROM merchant_api_keys WHERE key_id='" + id + "'")
  const first = (await revokeKey(ctx, state.ownerA, state.merchantA.id, target.keyId)).data
  const stamp = revokedAt(target.keyId)
  assert.ok(stamp, 'revocation must persist a revoked_at')

  const second = (await revokeKey(ctx, state.ownerA, state.merchantA.id, target.keyId)).data
  assert.equal(revokedAt(target.keyId), stamp, 'a repeat revoke must keep the first revoked_at')
  assert.equal(first.revokedAt, second.revokedAt)
  for (const value of [JSON.stringify(first), JSON.stringify(second)])
    assert.ok(!value.includes(target.key.slice(target.key.indexOf('.') + 1)))

  const missing = await revokeKey(ctx, state.ownerA, state.merchantA.id,
    '00000000-0000-4000-8000-000000000000', 404)
  assert.equal(missing.error.code, 'NOT_FOUND')
  return { httpStatus: 200,
    notes: 'revoke twice keeps the first revokedAt; no secret in either response; unknown keyId 404 NOT_FOUND. ' +
      'No production HTTP surface calls verifyApiKey yet (it is exported for the checkout consumer), so "revoked key cannot authenticate" is proven by unit/integration tests, not here' }
}

// M08 - earlier merchants and their outbox history survive; versions stay unique.
export async function m08(ctx, state) {
  for (const [merchant, owner] of [[state.merchantA, state.ownerA], [state.merchantB, state.ownerB]]) {
    const row = (await call(ctx, '/merchants/' + merchant.id, { token: owner.token })).data
    assert.equal(row.id, merchant.id)
    const events = outbox(ctx, merchant.id)
    const versions = events.map(event => event.version)
    assert.equal(new Set(versions).size, versions.length, 'aggregateVersion must stay unique')
    assert.equal(events.filter(event => event.eventType === 'merchant.registered').length, 1)
  }
  const duplicates = Number(sql(ctx, 'merchant_service',
    'SELECT count(*) FROM (SELECT aggregate_id, aggregate_version FROM merchant_outbox_events ' +
    'GROUP BY aggregate_id, aggregate_version HAVING count(*) > 1) d'))
  assert.equal(duplicates, 0)

  const published = sql(ctx, 'merchant_service',
    "SELECT count(*) FROM merchant_outbox_events WHERE status='PUBLISHED'")
  return { notes: 'merchants A/B intact; registered event once each; zero duplicate (aggregate_id, aggregate_version); ' +
    published + ' outbox row(s) PUBLISHED by the real publisher' }
}
