import './setup'
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import request from 'supertest'
import { prisma } from '../src/config/prisma'
import { clearDatabase, testApp, tokenFor, USER_ID } from './helpers'

beforeEach(clearDatabase)

const auth = { 'x-gateway-token': tokenFor() }

test('bill lookup is deterministic and derives the amount from the last two digits', async () => {
  const { app } = testApp()
  const response = await request(app)
    .get('/api/utilities/bills/lookup?provider=EVN&customerCode=KH1234')
    .set(auth)

  assert.equal(response.status, 200)
  assert.equal(response.body.data.amount, '44000')
  assert.equal(response.body.data.customerCode, 'KH1234')
})

test('bill lookup surfaces the provider error for codes ending in 11 and 22', async () => {
  const { app } = testApp()
  const notFound = await request(app)
    .get('/api/utilities/bills/lookup?provider=EVN&customerCode=KH0011')
    .set(auth)
  const timeout = await request(app)
    .get('/api/utilities/bills/lookup?provider=EVN&customerCode=KH0022')
    .set(auth)

  assert.equal(notFound.status, 422)
  assert.equal(notFound.body.error.code, 'BILL_NOT_FOUND')
  assert.equal(timeout.status, 504)
  assert.equal(timeout.body.error.code, 'PROVIDER_TIMEOUT')
})

test('paying a bill with the wrong amount is rejected with BILL_AMOUNT_MISMATCH and creates no order', async () => {
  const { app, paymentClient } = testApp()
  const response = await request(app)
    .post('/api/utilities/bills/pay')
    .set(auth)
    .set('Idempotency-Key', 'bill-key-1')
    .send({ provider: 'EVN', customerCode: 'KH1234', amount: '45000' })

  assert.equal(response.status, 409)
  assert.equal(response.body.error.code, 'BILL_AMOUNT_MISMATCH')
  assert.equal(paymentClient.checkouts.length, 0)
  assert.equal(await prisma.utilityOrder.count(), 0)
})

test('paying a bill with the matching amount creates a BILL_PAY order', async () => {
  const { app } = testApp()
  const response = await request(app)
    .post('/api/utilities/bills/pay')
    .set(auth)
    .set('Idempotency-Key', 'bill-key-1')
    .send({ provider: 'EVN', customerCode: 'KH1234', amount: '44000' })

  assert.equal(response.status, 201)
  assert.equal(response.body.data.type, 'BILL_PAY')
  assert.equal(response.body.data.target, 'KH1234')
  assert.equal(response.body.data.providerCode, 'EVN')
  assert.equal(response.body.data.discountAmount, '1320')
  assert.equal(await prisma.utilityOrder.count({ where: { userId: USER_ID } }), 1)
})
