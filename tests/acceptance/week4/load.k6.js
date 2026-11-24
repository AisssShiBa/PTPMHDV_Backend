// Run through load.mjs only: credentials stay in the private acceptance cache.
import http from 'k6/http'
import { check, sleep } from 'k6'
import { SharedArray } from 'k6/data'
import { Trend, Rate, Counter } from 'k6/metrics'

const fixture = JSON.parse(open('/private/load-fixture.json'))
if (!/^finvault-acceptance-[0-9a-f]{12}$/.test(fixture.project) || fixture.base !== 'http://gateway:3000/api') {
  throw new Error('Expected an isolated acceptance fixture')
}
const users = new SharedArray('senders', () => fixture.senders)
const checkoutMs = new Trend('checkout_ms', true)
const confirmMs = new Trend('confirm_ms', true)
const checkoutErrors = new Rate('checkout_errors')
const confirmErrors = new Rate('confirm_errors')
const throttled = new Counter('responses_429')
const completed = new Counter('transfers_completed')
export const options = {
  scenarios: { p2p: { executor: 'constant-vus', vus: 50, duration: '5m', gracefulStop: '30s' } },
  summaryTrendStats: ['avg', 'min', 'max', 'p(95)', 'count'],
  thresholds: { checkout_errors: ['rate<0.01'], confirm_errors: ['rate<0.01'],
    transfers_completed: ['count>=50'], checks: ['rate>0.99'] },
  // Never print per-payment URLs or credentials into time-series output.
  systemTags: ['status', 'method', 'name', 'scenario', 'expected_response'],
}

function post(path, body, user, name, extra = {}) {
  const response = http.post(fixture.base + path, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + user.token, ...extra },
    tags: { name }, timeout: '15s', redirects: 0,
  })
  if (response.status === 429) throttled.add(1)
  return response
}
function data(response) { try { return response.json('data') } catch { return null } }

export default function () {
  // Realistic think time keeps all 50 users inside the unchanged single-IP
  // 120/min policy: three protected requests/user, staggered over 100 seconds.
  if (__ITER === 0) sleep((__VU - 1) * 2)
  const started = Date.now()
  const user = users[__VU - 1]
  const checkout = post('/payments/checkout', {
    type: 'WALLET_TRANSFER', destinationUserId: fixture.receiverId, amount: '1000',
  }, user, 'POST checkout', { 'Idempotency-Key': `${fixture.project}-vu${__VU}-i${__ITER}` })
  checkoutMs.add(checkout.timings.duration)
  const payment = data(checkout)
  const checkoutOk = checkout.status === 201 && !!payment?.id
  checkoutErrors.add(!checkoutOk)
  check(checkout, { 'checkout creates payment': () => checkoutOk })
  if (checkoutOk) {
    const pin = post('/auth/pin/verify', { pin: fixture.pin, paymentId: payment.id, amount: '1000' }, user, 'POST PIN verify')
    const transactionToken = data(pin)?.transactionToken
    const pinOk = pin.status === 200 && !!transactionToken
    check(pin, { 'real PIN returns bound token': () => pinOk })
    if (pinOk) {
      const confirmation = post('/payments/' + payment.id + '/confirm', { transactionToken }, user, 'POST confirm')
      confirmMs.add(confirmation.timings.duration)
      const ok = confirmation.status === 200 && data(confirmation)?.status === 'SUCCESS'
      confirmErrors.add(!ok)
      check(confirmation, { 'confirm succeeds': () => ok })
      if (ok) completed.add(1)
    } else {
      confirmErrors.add(true)
    }
  }
  sleep(Math.max(0, 120 - (Date.now() - started) / 1000))
}

export function handleSummary(summary) {
  return { '/private/load-summary.json': JSON.stringify({ project: fixture.project,
    testedAt: new Date().toISOString(), workload: { vus: 50, duration: '5m',
      staggerSeconds: 2, cycleSeconds: 120, amount: '1000', rateLimitsUnchanged: true },
    metrics: summary.metrics, state: summary.state }, null, 2) }
}
