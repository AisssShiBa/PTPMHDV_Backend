// Week 3 / H14 KYC module: K01-K08 against the real HTTP stack, real
// user-service/admin-service PostgreSQL rows, the real Outbox publisher and the
// real wallet-service consumer. Nothing here is answered from source code; every
// PASS is a response or a durable row observed in this run.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { account, broker, call, docker, documents, pause, sql, until, uuid } from '../week2/runtime.mjs'
import { Blocked } from './reporting.mjs'

// Deliberately distinctive so a log-hygiene scan (K08) can prove it never
// reaches stdout, and so the owner-read assertion cannot match by accident.
export const REASON = 'Synthetic rejection: the back image is unreadable.'
export const ID_NUMBER = '000000001234'

async function subject(ctx, label) {
  const user = await account(ctx, label)
  const uploaded = await call(ctx, '/users/kyc/documents', {
    method: 'POST', token: user.token, body: await documents(), expected: 202
  })
  assert.equal(uploaded.data.kycStatus, 'PENDING')
  return user
}

function review(ctx, admin, profileId, body, expected = 200) {
  return call(ctx, '/admin/kyc/' + profileId + '/review', { method: 'POST', token: admin.token, body, expected })
}

function row(ctx, profileId) {
  const [status, tier, reason, version] = sql(ctx, 'user_service',
    "SELECT kyc_status, kyc_tier, COALESCE(kyc_reject_reason,''), version FROM users WHERE id='" + profileId + "'").split('|')
  return { status, tier: Number(tier), reason, version: Number(version) }
}

function eventCount(ctx, profileId, type) {
  return Number(sql(ctx, 'user_service', "SELECT count(*) FROM user_outbox_events WHERE aggregate_id='" +
    profileId + "' AND event_type='" + type + "'"))
}

function payloads(ctx, profileId) {
  const text = sql(ctx, 'user_service', "SELECT payload::text FROM user_outbox_events WHERE aggregate_id='" +
    profileId + "' ORDER BY aggregate_version")
  return text ? text.split('\n').map(line => JSON.parse(line)) : []
}

function walletTier(ctx, authUserId) {
  return sql(ctx, 'wallet_service',
    'SELECT "kycTier" FROM "Wallet" WHERE "userId"=\'' + authUserId + "' AND \"ownerType\"='USER'")
}

function publishKycUpdated(ctx, payloadText) {
  // broker() runs inside user-publisher with a confirm channel. The payload is
  // replayed byte-for-byte so the consumer's payloadHash matches the original.
  return broker(ctx, 'const payload=' + JSON.stringify(payloadText) + ';' +
    "const eventId=JSON.parse(payload).eventId;await ch.assertExchange('finvault.events','topic',{durable:true});" +
    "ch.publish('finvault.events','user.kyc_updated',Buffer.from(payload),{persistent:true," +
    "contentType:'application/json',messageId:eventId,type:'user.kyc_updated'});" +
    "await ch.waitForConfirms();console.log('published')")
}

// K01 - reject without a usable reason: 400 on both the Admin -> User contract
// and the User service schema, with no status, tier, reason, version or event change.
export async function k01(ctx, state) {
  const user = await subject(ctx, 'k01')
  const before = row(ctx, user.profileId)
  assert.equal(before.status, 'PENDING')
  assert.equal(before.tier, 0)

  const adminBodies = [
    { status: 'REJECTED' },
    { status: 'REJECTED', detail: '' },
    { status: 'REJECTED', detail: '   ' },
    { status: 'REJECTED', detail: 'x'.repeat(501) },
    { status: 'REJECTED', detail: 12345 },
    { status: 'REJECTED', detail: null }
  ]
  for (const body of adminBodies) {
    const response = await review(ctx, state.admin, user.profileId, body, null)
    assert.equal(response.httpStatus, 400, 'Admin accepted a malformed reject body: ' + JSON.stringify(body))
    assert.equal(response.error.code, 'VALIDATION_ERROR')
  }

  const userBodies = [
    { kycStatus: 'REJECTED' },
    { kycStatus: 'REJECTED', reason: '   ' },
    { kycStatus: 'REJECTED', reason: 'Valid text but an unknown field', extra: true }
  ]
  for (const body of userBodies) {
    const response = await call(ctx, '/users/' + user.profileId + '/kyc-status', {
      method: 'PATCH', token: state.admin.token, body, expected: 400
    })
    assert.equal(response.error.code, 'VALIDATION_ERROR')
  }

  const after = row(ctx, user.profileId)
  assert.deepEqual(after, before)
  assert.equal(eventCount(ctx, user.profileId, 'user.kyc_updated'), 0)
  assert.equal(eventCount(ctx, user.profileId, 'user.kyc_reviewed'), 0)
  assert.equal(Number(sql(ctx, 'admin_service', 'SELECT count(*) FROM "AdminAuditLog" WHERE "targetId"=\'' +
    user.profileId + '\'')), 0)

  return { httpStatus: 400, errorCode: 'VALIDATION_ERROR',
    notes: '9 malformed bodies rejected; profile unchanged (PENDING, tier 0, version ' + before.version + '); zero outbox rows and zero audit rows' }
}

// K02 - reject with a reason reaches the owner and the audit trail, and no
// other principal can read the reason.
export async function k02(ctx, state) {
  const user = await subject(ctx, 'k02')
  state.k02 = user

  const response = await review(ctx, state.admin, user.profileId, { status: 'REJECTED', detail: REASON })
  assert.equal(response.data.kycStatus, 'REJECTED')
  // The returned audit row legitimately holds the reason the admin supplied; the
  // profile payload must not. Assert on data, not on the whole envelope.
  assert.ok(!JSON.stringify(response.data).includes(REASON), 'the Admin profile payload must not echo the reject reason')

  const stored = row(ctx, user.profileId)
  assert.equal(stored.status, 'REJECTED')
  assert.equal(stored.reason, REASON)

  const mine = await call(ctx, '/users/me/kyc', { token: user.token })
  assert.equal(mine.data.kycStatus, 'REJECTED')
  assert.equal(mine.data.kycRejectReason, REASON)

  const ownProfile = await call(ctx, '/users/' + user.profileId, { token: user.token })
  assert.ok(!('kycRejectReason' in ownProfile.data), 'the generic profile payload must not carry the reason')
  const me = await call(ctx, '/users/me', { token: user.token })
  assert.ok(!('kycRejectReason' in me.data), 'the generic /me payload must not carry the reason')

  const foreignProfile = await call(ctx, '/users/' + user.profileId, { token: state.other.token, expected: 403 })
  assert.equal(foreignProfile.error.code, 'FORBIDDEN')
  const foreignKyc = await call(ctx, '/users/me/kyc', { token: state.other.token })
  assert.ok(!JSON.stringify(foreignKyc.data).includes(REASON), 'another principal must never receive the reason')

  assert.equal(Number(sql(ctx, 'admin_service', 'SELECT count(*) FROM "AdminAuditLog" WHERE "targetId"=\'' +
    user.profileId + "' AND action='REJECT_KYC'")), 1)
  const audit = JSON.parse(sql(ctx, 'admin_service', 'SELECT detail FROM "AdminAuditLog" WHERE "targetId"=\'' +
    user.profileId + "' AND action='REJECT_KYC'"))
  assert.equal(audit.outcome, 'SUCCEEDED')
  assert.equal(audit.reason, REASON)
  assert.equal(audit.kycStatus, 'REJECTED')

  return { httpStatus: 200, errorCode: null,
    notes: 'owner sees the reason on /users/me/kyc only; generic payloads omit it; another USER gets 403; one REJECT_KYC audit row carries outcome SUCCEEDED and the same reason' }
}

// K03 - plan section 9.1 says a reject from PENDING must not silently drop the
// tier the profile already holds. The code currently forces tier 0, so this is
// reported BLOCKED with the observed transition as evidence, not as acceptance.
export async function k03(ctx, state) {
  const user = await subject(ctx, 'k03')
  // Only reachable state-shaping call: kyc-tier requires APPROVED, so seed the
  // tier directly. It does not touch version, status or the outbox.
  sql(ctx, 'user_service', "UPDATE users SET kyc_tier=1 WHERE id='" + user.profileId + "'")
  const before = row(ctx, user.profileId)
  assert.equal(before.status, 'PENDING')
  assert.equal(before.tier, 1)

  const response = await review(ctx, state.admin, user.profileId, { status: 'REJECTED', detail: REASON })
  assert.equal(response.data.kycStatus, 'REJECTED')
  const after = row(ctx, user.profileId)
  assert.equal(after.status, 'REJECTED')
  assert.equal(after.version, before.version + 1)

  const events = payloads(ctx, user.profileId)
  const evidence = { seeded: before, after, events, plan: '9.1: REJECTED from PENDING must not lower the existing tier' }
  writeFileSync(resolve(ctx.directory, 'k03-evidence.json'), JSON.stringify(evidence, null, 2))

  if (after.tier !== before.tier) {
    throw new Blocked('PARTIAL: reject-with-reason works, but PENDING tier ' + before.tier + ' became tier ' +
      after.tier + ' (plan 9.1 wants the tier preserved). The outbox row ' +
      JSON.stringify(events.map(e => e.data)) + ' would also push that downgrade to Wallet. ' +
      'State transition/backward compatibility needs agreement (Khoa money, Dat review) before the test is rewritten. See k03-evidence.json.')
  }
  assert.equal(events.length, 0, 'a preserved tier must not emit a tier event')
  return { httpStatus: 200, errorCode: null, notes: 'tier ' + before.tier + ' preserved; no tier event emitted' }
}

// K04 - approval keeps exactly one user.kyc_updated and emits no review event.
export async function k04(ctx, state) {
  const user = await subject(ctx, 'k04')
  state.k04 = user

  const response = await review(ctx, state.admin, user.profileId, { status: 'APPROVED' })
  assert.equal(response.data.kycStatus, 'APPROVED')
  assert.equal(response.data.kycTier, 1)

  await until(() => Number(sql(ctx, 'user_service', "SELECT count(*) FROM user_outbox_events WHERE aggregate_id='" +
    user.profileId + "' AND event_type='user.kyc_updated' AND status='PUBLISHED'")) === 1,
    'K04: the tier event was not published')

  const events = payloads(ctx, user.profileId)
  assert.equal(events.length, 1)
  assert.equal(events[0].eventType, 'user.kyc_updated')
  assert.deepEqual(events[0].data, { authUserId: user.id, kycTier: 1, previousTier: 0 })
  assert.equal(eventCount(ctx, user.profileId, 'user.kyc_reviewed'), 0)

  await until(() => walletTier(ctx, user.id) === '1', 'K04: the wallet consumer did not apply the tier')

  return { httpStatus: 200, errorCode: null,
    notes: 'one PUBLISHED user.kyc_updated {kycTier 1, previousTier 0}; zero user.kyc_reviewed; Wallet.kycTier=1' }
}

// K04-REVIEW - the planned review event is structurally impossible today. Prove
// both blockers live, then report BLOCKED rather than pretending the event exists.
export async function k04Review(ctx, state) {
  const user = state.k04
  if (!user) throw new Blocked('The K04 approval subject did not run; cannot evaluate the review event')

  const [version, eventId] = sql(ctx, 'user_service', "SELECT aggregate_version, id FROM user_outbox_events WHERE aggregate_id='" +
    user.profileId + "' ORDER BY aggregate_version DESC LIMIT 1").split('|')
  const probeId = uuid()
  let violation = null
  try {
    sql(ctx, 'user_service', 'INSERT INTO user_outbox_events (id, aggregate_id, aggregate_version, event_type, payload) VALUES (\'' +
      probeId + "', '" + user.profileId + "', " + version + ", 'user.kyc_reviewed', '{\"probe\":true}'::json)")
  } catch (error) {
    violation = String(error.stderr || error.message)
  }
  if (violation === null) {
    sql(ctx, 'user_service', "DELETE FROM user_outbox_events WHERE id='" + probeId + "'")
    throw new Error('the (aggregateId, aggregateVersion) unique index no longer blocks a second event for one transition')
  }
  assert.match(violation, /duplicate key|23505/i, 'unexpected insert failure: ' + violation.split('\n')[0])
  assert.equal(Number(sql(ctx, 'user_service', "SELECT count(*) FROM user_outbox_events WHERE aggregate_id='" +
    user.profileId + "'")), 1, 'the rejected probe must not leave a row behind')

  const registry = docker(ctx, 'exec', '-T', 'user-publisher', 'node', '-e',
    "const {parseFinvaultEvent}=require('finvault-events');try{parseFinvaultEvent({eventId:'" + uuid() +
    "',eventType:'user.kyc_reviewed',eventVersion:1,occurredAt:new Date().toISOString(),data:{authUserId:'" + user.id +
    "',status:'REJECTED'}});console.log('ACCEPTED')}catch(e){console.log(String(e.reason||e.code||e.message))}")
  assert.equal(registry, 'UNKNOWN_EVENT_TYPE')

  writeFileSync(resolve(ctx.directory, 'k04-review-evidence.json'), JSON.stringify({
    aggregateVersionUsedByTierEvent: Number(version), uniqueViolation: violation.split('\n')[0],
    publisherParseResult: registry, note: 'The review event needs an outbox ordering decision and a registry entry.'
  }, null, 2))
  throw new Blocked('BLOCKED by plan 9.2/10.1: (1) user_outbox_events is unique on (aggregate_id, aggregate_version) and the tier event already owns version ' +
    version + ' (insert failed with 23505), (2) parseFinvaultEvent answers ' + registry +
    ' because packages/finvault-events has no schema. Publishing outside the transaction is forbidden. Owners: Nguyen/Dat. See k04-review-evidence.json.')
}

// K05 - two concurrent reviews change state once and emit one event.
export async function k05(ctx, state) {
  const user = await subject(ctx, 'k05')
  await review(ctx, state.admin, user.profileId, { status: 'APPROVED' })
  const before = row(ctx, user.profileId)
  assert.equal(before.status, 'APPROVED')
  assert.equal(before.tier, 1)

  const reasons = ['Concurrent review A', 'Concurrent review B']
  // expected: null because either status is a correct outcome for the loser.
  const responses = await Promise.all(reasons.map(detail =>
    review(ctx, state.admin, user.profileId, { status: 'REJECTED', detail }, null)))
  const statuses = responses.map(response => response.httpStatus)
  assert.ok(statuses.every(status => status === 200 || status === 409), 'unexpected statuses ' + statuses)
  assert.ok(statuses.includes(200), 'at least one review must succeed')

  const after = row(ctx, user.profileId)
  assert.equal(after.status, 'REJECTED')
  assert.equal(after.version, before.version + 1)
  assert.ok(reasons.includes(after.reason))

  const events = payloads(ctx, user.profileId)
  assert.equal(events.length, 2, 'approve + one reject = two events, got ' + events.length)
  const downgrade = events.filter(event => event.data.kycTier === 0 && event.data.previousTier === 1)
  assert.equal(downgrade.length, 1)

  return { httpStatus: statuses.join('/'), errorCode: null,
    notes: 'statuses ' + statuses.join('/') + '; version ' + before.version + '->' + after.version + '; exactly one {previousTier 1 -> kycTier 0} event' }
}

// K06 - the post-confirm crash window: a confirmed event is redelivered with the
// same eventId. WalletInbox must dedupe the identical copy and dead-letter a
// conflicting payload without touching the wallet.
export async function k06(ctx, state) {
  const user = state.k04
  if (!user) throw new Blocked('The K04 approval subject did not run; no published event to replay')

  const payloadText = sql(ctx, 'user_service', "SELECT payload::text FROM user_outbox_events WHERE aggregate_id='" +
    user.profileId + "' AND event_type='user.kyc_updated' ORDER BY aggregate_version LIMIT 1")
  const payload = JSON.parse(payloadText)
  assert.equal(payload.eventType, 'user.kyc_updated')
  const eventId = payload.eventId

  const inbox = () => Number(sql(ctx, 'wallet_service',
    'SELECT count(*) FROM "WalletInbox" WHERE "eventId"=\'' + eventId + "'"))
  assert.equal(inbox(), 1)

  publishKycUpdated(ctx, payloadText)
  publishKycUpdated(ctx, payloadText)
  await pause(2500)
  assert.equal(inbox(), 1, 'a duplicate delivery must not create a second inbox row')
  assert.equal(walletTier(ctx, user.id), '1')

  const dlq = () => Number(broker(ctx,
    "const q=await ch.checkQueue('wallet-service.kyc-updated.dlq');console.log(q.messageCount)"))
  const dlqBefore = dlq()
  // The alteration must stay schema-valid (tier is 0..2) and use the
  // passthrough extra field, otherwise the consumer rejects it as
  // INVALID_PAYLOAD before the Inbox can compare the payload hash.
  const altered = { ...payload, data: { ...payload.data, conflictProbe: 'different payload, same eventId' } }
  publishKycUpdated(ctx, JSON.stringify(altered))
  await until(() => dlq() > dlqBefore, 'K06: a conflicting payload was not dead-lettered', 15000)
  assert.equal(inbox(), 1, 'a conflicting payload must not insert an inbox row')
  assert.equal(walletTier(ctx, user.id), '1', 'a conflicting payload must not change the wallet tier')

  const dead = JSON.parse(broker(ctx,
    "const out=[];let m;while(m=await ch.get('wallet-service.kyc-updated.dlq',{noAck:true})){" +
    "const e=JSON.parse(m.content.toString());out.push({id:e.eventId,reason:m.properties.headers?.['x-dlq-reason']})}" +
    'console.log(JSON.stringify(out))'))
  const ours = dead.filter(entry => entry.id === eventId)
  assert.ok(ours.some(entry => entry.reason === 'EVENT_CONFLICT'), 'conflict reason missing: ' + JSON.stringify(dead))

  return { httpStatus: null, errorCode: 'EVENT_CONFLICT',
    notes: 'two identical redeliveries kept WalletInbox at one row and tier 1; an altered payload for the same eventId was dead-lettered as EVENT_CONFLICT. A real process kill is not simulated; the crash-after-confirm outcome is this duplicate delivery.' }
}

// K07 - signed image URLs: the run config pins 2 s so expiry is observable;
// the production default of 900 s is a recorded configuration fact.
export async function k07(ctx, state) {
  const user = state.k04
  if (!user) throw new Blocked('The K04 approval subject did not run; no documents to sign')
  assert.equal(ctx.config.KYC_URL_TTL_SECONDS, '2')

  const issued = await call(ctx, '/admin/kyc/' + user.profileId + '/documents', { token: state.admin.token })
  assert.match(issued.headers.get('cache-control'), /no-store/)
  const urls = [issued.data.frontUrl, issued.data.backUrl]
  assert.notEqual(urls[0], urls[1])

  for (const url of urls) {
    assert.equal(new URL(url).searchParams.get('X-Amz-Expires'), '2')
    assert.equal((await fetch(url, { signal: AbortSignal.timeout(5000) })).status, 200)
    const unsigned = new URL(url)
    unsigned.search = ''
    assert.equal((await fetch(unsigned, { signal: AbortSignal.timeout(5000) })).status, 403)
  }

  const owner = await call(ctx, '/users/' + user.profileId + '/kyc/document', { token: user.token })
  assert.equal(owner.data.expiresIn, 2)

  await pause(Math.max(0, Date.parse(issued.data.expiresAt) - Date.now()) + 1200)
  for (const url of urls) assert.equal((await fetch(url, { signal: AbortSignal.timeout(5000) })).status, 403)

  return { httpStatus: 200, errorCode: null,
    notes: 'X-Amz-Expires=2 honoured from KYC_URL_TTL_SECONDS, Cache-Control no-store, unsigned URL 403, both URLs 403 after expiresAt. Production default 900 s is configured at env.ts:17, docker-compose.yml:73 and services/user-service/.env.example:13 (root .env.example has no such key)' }
}

// K08 - every wrong-endpoint image read is 403 and nothing sensitive reaches
// the service logs or the error bodies.
export async function k08(ctx, state) {
  const user = state.k02
  if (!user) throw new Blocked('The K02 rejection subject did not run; no documents to probe')

  const results = [
    await call(ctx, '/users/' + user.profileId + '/kyc/document', { token: state.admin.token, expected: 403 }),
    await call(ctx, '/users/' + user.profileId + '/kyc/documents', { token: state.admin.token, expected: 403 }),
    await call(ctx, '/users/' + user.profileId + '/kyc/documents', { token: user.token, expected: 403 }),
    await call(ctx, '/users/' + user.profileId + '/kyc/document', { token: state.other.token, expected: 403 })
  ]
  for (const result of results) assert.equal(result.error.code, 'FORBIDDEN')
  const bodies = JSON.stringify(results)
  assert.ok(!bodies.includes(ID_NUMBER) && !bodies.includes('X-Amz-Signature'),
    'a 403 body leaked document or signature material')

  const since = state.startedAt.replace(/\.\d+Z$/, 'Z')
  const logs = docker(ctx, 'logs', '--no-color', '--since', since,
    'gateway', 'user-service', 'admin-service', 'user-publisher', 'wallet-service')
  for (const needle of [ID_NUMBER, 'X-Amz-Signature', 'X-Amz-Credential', 'X-Amz-Expires', REASON]) {
    assert.ok(!logs.includes(needle), 'service logs leaked: ' + needle)
  }

  return { httpStatus: 403, errorCode: 'FORBIDDEN',
    notes: 'ADMIN on the owner routes, USER on the internal documents route and a foreign USER all get 403; logs since ' + since + ' contain no CCCD number, no presigned-URL parameter and no reject reason' }
}
