import './setup'
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import request from 'supertest'
import { MockProviderEngine } from '../src/services/mockProviderEngine'
import { clearDatabase, testApp } from './helpers'

const INTERNAL_KEY = 'test-internal-key-01234567890123456789'

beforeEach(clearDatabase)

test('the mock provider returns the same result for the same orderId and counts one delivery', () => {
  const engine = new MockProviderEngine()
  const first = engine.execute({ orderId: 'order-1', key: '0912345600' })
  const second = engine.execute({ orderId: 'order-1', key: '0912345600' })

  assert.deepEqual(first, { status: 'SUCCESS', providerRef: 'MOCK-order-1' })
  assert.deepEqual(second, first)
  assert.equal(engine.deliveredCount(), 1)
})

test('a phone ending in 11 is rejected and ending in 22 reveals SUCCESS on the first status query', () => {
  const engine = new MockProviderEngine()
  assert.deepEqual(engine.execute({ orderId: 'reject', key: '0912345611' }), {
    status: 'FAILED',
    reason: 'PROVIDER_REJECTED'
  })

  assert.deepEqual(engine.execute({ orderId: 'timeout', key: '0912345622' }), {
    status: 'TIMEOUT'
  })
  assert.deepEqual(engine.query('timeout'), {
    status: 'SUCCESS',
    providerRef: 'MOCK-timeout'
  })
  assert.deepEqual(engine.query('timeout'), {
    status: 'SUCCESS',
    providerRef: 'MOCK-timeout'
  })
})

test('the mock route rejects missing or wrong internal credentials with 401', async () => {
  const { app } = testApp({ mockProviderEnabled: true })
  const missing = await request(app)
    .post('/internal/mock-provider/topup')
    .send({ orderId: 'order-1', phone: '0912345600', amount: '50000' })
  const wrong = await request(app)
    .post('/internal/mock-provider/topup')
    .set('x-internal-key', 'wrong-key')
    .send({ orderId: 'order-1', phone: '0912345600', amount: '50000' })

  assert.equal(missing.status, 401)
  assert.equal(wrong.status, 401)
})

test('the mock route does not exist when MOCK_PROVIDER_ENABLED is false', async () => {
  const { app } = testApp({ mockProviderEnabled: false })
  const response = await request(app)
    .post('/internal/mock-provider/topup')
    .set('x-internal-key', INTERNAL_KEY)
    .send({ orderId: 'order-1', phone: '0912345600', amount: '50000' })

  assert.equal(response.status, 404)
})

test('the mock route is idempotent per orderId and returns deterministic outcomes', async () => {
  const { app } = testApp({ mockProviderEnabled: true })
  const post = (orderId: string, phone: string) =>
    request(app)
      .post('/internal/mock-provider/topup')
      .set('x-internal-key', INTERNAL_KEY)
      .send({ orderId, phone, amount: '50000' })

  const first = await post('order-1', '0912345600')
  const second = await post('order-1', '0912345600')
  const rejected = await post('order-2', '0912345611')
  const timeout = await post('order-3', '0912345622')

  assert.equal(first.status, 200)
  assert.equal(first.body.data.providerRef, 'MOCK-order-1')
  assert.equal(second.body.data.providerRef, 'MOCK-order-1')
  assert.equal(rejected.status, 422)
  assert.equal(timeout.status, 504)
})

test('the mock status route reveals SUCCESS for a timed-out order', async () => {
  const { app } = testApp({ mockProviderEnabled: true })
  await request(app)
    .post('/internal/mock-provider/topup')
    .set('x-internal-key', INTERNAL_KEY)
    .send({ orderId: 'order-3', phone: '0912345622', amount: '50000' })

  const response = await request(app)
    .get('/internal/mock-provider/orders/order-3')
    .set('x-internal-key', INTERNAL_KEY)

  assert.equal(response.status, 200)
  assert.equal(response.body.data.status, 'SUCCESS')
})
