import './setup'
import assert from 'node:assert/strict'
import http from 'node:http'
import { beforeEach, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { createUtilityApp } from '../src/app'
import { prisma } from '../src/config/prisma'
import { MockProviderEngine } from '../src/services/mockProviderEngine'
import { HttpPaymentClient, PaymentClientError } from '../src/services/paymentClient'
import { clearDatabase, FakeProviderClient, startFakePaymentService, testApp, tokenFor, USER_ID } from './helpers'

beforeEach(clearDatabase)

const topup = (
  app: ReturnType<typeof testApp>['app'],
  body: Record<string, unknown>,
  key = 'key-1'
) =>
  request(app)
    .post('/api/utilities/topup')
    .set('x-gateway-token', tokenFor())
    .set('Idempotency-Key', key)
    .send(body)

test('a new order stores the 3% discount as an integer and never moves money itself', async () => {
  const { app, paymentClient } = testApp()
  const response = await topup(app, { phone: '0912345600', amount: '50000' })
  assert.equal(response.status, 201)
  assert.equal(response.body.data.discountAmount, '1500')
  assert.equal(response.body.data.status, 'PENDING_PAYMENT')
  assert.equal(paymentClient.checkouts.length, 1)
})

test('discount uses floor(amount * 3 / 100) for every denomination', async () => {
  const expected: Record<string, string> = {
    '10000': '300',
    '20000': '600',
    '50000': '1500',
    '100000': '3000',
    '200000': '6000',
    '500000': '15000'
  }
  const { app } = testApp()
  for (const [amount, discount] of Object.entries(expected)) {
    const response = await topup(app, { phone: '0912345600', amount }, `key-${amount}`)
    assert.equal(response.body.data.discountAmount, discount, amount)
  }
})

test('the same key with the same payload replays the existing order', async () => {
  const { app } = testApp()
  const first = await topup(app, { phone: '0912345600', amount: '50000' })
  const second = await topup(app, { phone: '0912345600', amount: '50000' })

  assert.equal(first.status, 201)
  assert.equal(second.status, 200)
  assert.equal(second.body.data.orderId, first.body.data.orderId)
  assert.equal(second.body.data.replayed, true)
  assert.equal(await prisma.utilityOrder.count({ where: { userId: USER_ID } }), 1)
})

test('the same key with a different payload is rejected with 422', async () => {
  const { app } = testApp()
  await topup(app, { phone: '0912345600', amount: '50000' })
  const response = await topup(app, { phone: '0912345600', amount: '100000' })

  assert.equal(response.status, 422)
  assert.equal(response.body.error.code, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD')
})

test('twenty concurrent requests with one key create one order and one payment', async () => {
  const { app, paymentClient } = testApp()
  const responses = await Promise.all(
    Array.from({ length: 20 }, () => topup(app, { phone: '0912345600', amount: '50000' }))
  )
  const rows = await prisma.utilityOrder.findMany({ where: { userId: USER_ID } })
  const paymentIds = new Set(rows.map(row => row.paymentId).filter(Boolean))

  assert.equal(rows.length, 1)
  assert.equal(paymentIds.size, 1)
  assert.ok(responses.every(response => response.status === 200 || response.status === 201))
  assert.ok(paymentClient.checkouts.length <= 20)
})

test('a 5xx checkout keeps PENDING_PAYMENT and a retry resumes the same order', async () => {
  const { app, paymentClient } = testApp()
  paymentClient.checkoutHandler = async () => {
    throw new PaymentClientError('unavailable', 503, 'UPSTREAM', false)
  }

  const failed = await topup(app, { phone: '0912345600', amount: '50000' })
  assert.equal(failed.status, 502)
  const pending = await prisma.utilityOrder.findFirstOrThrow({ where: { userId: USER_ID } })
  assert.equal(pending.status, 'PENDING_PAYMENT')
  assert.equal(pending.paymentId, null)

  paymentClient.checkoutHandler = async req => ({
    paymentId: `pay-${req.referenceId}`,
    status: 'PENDING',
    replayed: false
  })
  const resumed = await topup(app, { phone: '0912345600', amount: '50000' })
  assert.equal(resumed.status, 200)
  assert.equal(resumed.body.data.paymentId, `pay-${pending.id}`)
  assert.equal(await prisma.utilityOrder.count({ where: { userId: USER_ID } }), 1)
})

test('a definite 4xx checkout marks the order FAILED and forwards the payment code', async () => {
  const { app, paymentClient } = testApp()
  paymentClient.checkoutHandler = async () => {
    throw new PaymentClientError('rejected', 400, 'PAYMENT_TYPE_UNSUPPORTED', true)
  }

  const response = await topup(app, { phone: '0912345600', amount: '50000' })
  assert.equal(response.status, 400)
  assert.equal(response.body.error.code, 'PAYMENT_TYPE_UNSUPPORTED')
  const order = await prisma.utilityOrder.findFirstOrThrow({ where: { userId: USER_ID } })
  assert.equal(order.status, 'FAILED')
  assert.equal(order.failureReason, 'PAYMENT_TYPE_UNSUPPORTED')
})

test('checkout forwards the caller Gateway token and never the internal key', async () => {
  const captured: Array<{ headers: http.IncomingHttpHeaders; body: any }> = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => {
      raw += chunk
    })
    req.on('end', () => {
      captured.push({ headers: req.headers, body: JSON.parse(raw) })
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          success: true,
          data: { id: 'pay-http', status: 'PENDING', replayed: false }
        })
      )
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  try {
    const httpClient = new HttpPaymentClient(
      `http://127.0.0.1:${port}`,
      'test-internal-key-01234567890123456789',
      2000
    )
    const httpApp = createUtilityApp({
      paymentClient: httpClient,
      providerClient: new FakeProviderClient(),
      mockProviderEngine: new MockProviderEngine(),
      mockProviderEnabled: false
    })

    const gatewayToken = tokenFor()
    const response = await request(httpApp)
      .post('/api/utilities/topup')
      .set('x-gateway-token', gatewayToken)
      .set('Idempotency-Key', 'http-key-1')
      .send({ phone: '0912345600', amount: '50000' })

    assert.equal(response.status, 201)
    assert.equal(captured.length, 1)
    assert.equal(captured[0].headers['x-gateway-token'], gatewayToken)
    assert.equal(captured[0].headers['x-internal-key'], undefined)
    assert.equal(captured[0].body.type, 'PHONE_TOPUP')
    assert.equal(captured[0].body.referenceId, response.body.data.orderId)
    assert.equal(captured[0].headers['idempotency-key'], `util-${response.body.data.orderId}`)
    assert.equal(captured[0].body.idempotencyKey, `util-${response.body.data.orderId}`)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('a payment response with only the real Payment id field still stores paymentId', async () => {
  const fake = await startFakePaymentService()
  try {
    const httpClient = new HttpPaymentClient(
      fake.url,
      'test-internal-key-01234567890123456789',
      2000
    )
    const httpApp = createUtilityApp({
      paymentClient: httpClient,
      providerClient: new FakeProviderClient(),
      mockProviderEngine: new MockProviderEngine(),
      mockProviderEnabled: false
    })

    const response = await request(httpApp)
      .post('/api/utilities/topup')
      .set('x-gateway-token', tokenFor())
      .set('Idempotency-Key', 'http-id-key-1')
      .send({ phone: '0912345600', amount: '50000' })

    assert.equal(response.status, 201)
    assert.equal(fake.requests.length, 1)
    const order = await prisma.utilityOrder.findFirstOrThrow({ where: { userId: USER_ID } })
    assert.equal(order.paymentId, `pay-${order.id}`)
    assert.equal(response.body.data.paymentId, `pay-${order.id}`)
  } finally {
    await fake.close()
  }
})
