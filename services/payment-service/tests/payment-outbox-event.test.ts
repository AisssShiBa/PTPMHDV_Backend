import assert from 'node:assert/strict'
import { test } from 'node:test'
import { processPaymentOutboxEvent, type PaymentEventActions } from '../src/jobs/payment-outbox-event'

const makeRow = (retryCount = 0, payload: Record<string, unknown> = {
  id: 'payment-1',
  userId: 'sender',
  destinationUserId: 'receiver',
  amount: '50000.00'
}) => ({
  id: '00000000-0000-4000-8000-000000000001',
  aggregateId: 'payment-1',
  createdAt: new Date('2026-10-30T12:00:00Z'),
  eventType: 'PAYMENT_SUCCESS',
  retryCount,
  payload
}) as Parameters<typeof processPaymentOutboxEvent>[0]

test('invalid payment outbox data is failed immediately without retrying', async () => {
  let published = 0
  let failed = 0
  let scheduled = 0
  const actions: PaymentEventActions = {
    publish: async () => { published += 1 },
    markSent: async () => assert.fail('invalid event must not be marked SENT'),
    markFailed: async () => { failed += 1 },
    scheduleRetry: async () => { scheduled += 1 }
  }

  const result = await processPaymentOutboxEvent(makeRow(0, {
    id: 'payment-1',
    amount: '50000'
  }), actions)

  assert.equal(result, 'failed')
  assert.equal(failed, 1)
  assert.equal(published, 0)
  assert.equal(scheduled, 0)
})

test('transient broker failures retry with backoff and eventually mark the row SENT', async () => {
  let publishes = 0
  let status: 'PENDING' | 'SENT' | 'FAILED' = 'PENDING'
  const delays: number[] = []
  const actions: PaymentEventActions = {
    publish: async () => {
      publishes += 1
      if (publishes <= 3) throw new Error('broker unavailable')
    },
    markSent: async () => { status = 'SENT' },
    markFailed: async () => { status = 'FAILED' },
    scheduleRetry: async delayMs => { delays.push(delayMs) }
  }

  for (let retryCount = 0; retryCount < 4; retryCount += 1) {
    await processPaymentOutboxEvent(makeRow(retryCount), actions)
  }

  assert.equal(publishes, 4)
  assert.deepEqual(delays, [1000, 2000, 4000])
  assert.equal(status, 'SENT')
})
