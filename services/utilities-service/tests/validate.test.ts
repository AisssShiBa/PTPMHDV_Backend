import './setup'
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import request from 'supertest'
import { prisma } from '../src/config/prisma'
import {
  clearDatabase,
  OTHER_USER_ID,
  testApp,
  tokenFor,
  USER_ID
} from './helpers'

beforeEach(clearDatabase)

const topup = (
  app: ReturnType<typeof testApp>['app'],
  body: unknown,
  options: { key?: string | null; token?: string | null } = {}
) => {
  const req = request(app).post('/api/utilities/topup')
  if (options.token !== null) req.set('x-gateway-token', options.token ?? tokenFor())
  if (options.key !== null) req.set('Idempotency-Key', options.key ?? 'key-1')
  return req.send(body as object)
}

test('a missing Idempotency-Key is rejected with 400', async () => {
  const { app } = testApp()
  const response = await topup(app, { phone: '0912345600', amount: '50000' }, { key: null })
  assert.equal(response.status, 400)
  assert.equal(response.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED')
})

test('an over-long Idempotency-Key is rejected with 400', async () => {
  const { app } = testApp()
  const response = await topup(
    app,
    { phone: '0912345600', amount: '50000' },
    { key: 'a'.repeat(256) }
  )
  assert.equal(response.status, 400)
})

test('amounts outside the fixed denomination list are rejected with 400', async () => {
  const { app } = testApp()
  for (const amount of ['50001', '-1', '0', '5e4', '50000.5']) {
    const response = await topup(app, { phone: '0912345600', amount })
    assert.equal(response.status, 400, `amount=${amount}`)
    assert.equal(response.body.error.code, 'INVALID_AMOUNT')
  }
})

test('a phone number outside the Vietnamese mobile pattern is rejected with 400', async () => {
  const { app } = testApp()
  for (const phone of ['1234567890', '0212345678', '091234560', '84912345678']) {
    const response = await topup(app, { phone, amount: '50000' })
    assert.equal(response.status, 400, `phone=${phone}`)
    assert.equal(response.body.error.code, 'INVALID_PHONE')
  }
})

test('a +84 phone number is normalised to the local 0 form', async () => {
  const { app } = testApp()
  const response = await topup(app, { phone: '+84912345678', amount: '50000' })
  assert.equal(response.status, 201)
  assert.equal(response.body.data.target, '0912345678')
})

test('a userId in the body is ignored and ownership comes from the Gateway token', async () => {
  const { app } = testApp()
  const created = await topup(app, {
    phone: '0912345600',
    amount: '50000',
    userId: OTHER_USER_ID
  })
  assert.equal(created.status, 201)

  const foreign = await request(app)
    .get(`/api/utilities/orders/${created.body.data.orderId}`)
    .set('x-gateway-token', tokenFor(OTHER_USER_ID))
  assert.equal(foreign.status, 404)

  const rows = await prisma.utilityOrder.findMany({ where: { id: created.body.data.orderId } })
  assert.equal(rows[0]?.userId, USER_ID)
})

test('the utilities routes require a Gateway token', async () => {
  const { app } = testApp()
  const response = await topup(
    app,
    { phone: '0912345600', amount: '50000' },
    { token: null }
  )
  assert.equal(response.status, 401)
})
