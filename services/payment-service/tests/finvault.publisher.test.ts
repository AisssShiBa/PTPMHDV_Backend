import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPaymentFinvaultEvent } from '../src/events/finvault.publisher'

const row = (eventType: string, payload: Record<string, unknown>) => ({
  id: '00000000-0000-4000-8000-000000000001',
  aggregateId: 'payment-1',
  createdAt: new Date('2026-10-30T12:00:00Z'),
  eventType,
  payload
})

test('maps successful payment outbox rows to the versioned event envelope', () => {
  assert.deepEqual(buildPaymentFinvaultEvent(row('PAYMENT_SUCCESS', {
    id: 'payment-1',
    userId: 'sender',
    destinationUserId: 'receiver',
    amount: '50000.00',
    note: 'Dinner'
  })), {
    eventId: '00000000-0000-4000-8000-000000000001',
    eventType: 'payment.succeeded',
    eventVersion: 1,
    occurredAt: '2026-10-30T12:00:00.000Z',
    data: {
      paymentId: 'payment-1',
      senderId: 'sender',
      receiverId: 'receiver',
      amount: '50000',
      note: 'Dinner'
    }
  })
})

test('maps failed and expired payments to their notification contract payloads', () => {
  assert.deepEqual(buildPaymentFinvaultEvent(row('PAYMENT_FAILED', {
    id: 'payment-2',
    userId: 'sender',
    failureReason: 'DECLINED'
  }))?.data, {
    paymentId: 'payment-2',
    senderId: 'sender',
    reason: 'DECLINED'
  })
  assert.deepEqual(buildPaymentFinvaultEvent(row('PAYMENT_EXPIRED', {
    id: 'payment-3',
    userId: 'sender'
  }))?.data, {
    paymentId: 'payment-3',
    senderId: 'sender'
  })
})

test('leaves legacy payment event types to their existing publisher and rejects fractional VND', () => {
  assert.equal(buildPaymentFinvaultEvent(row('PAYMENT_REFUNDED', { userId: 'sender' })), undefined)
  assert.throws(() => buildPaymentFinvaultEvent(row('PAYMENT_SUCCESS', {
    id: 'payment-4',
    userId: 'sender',
    destinationUserId: 'receiver',
    amount: '50.25'
  })), /whole VND/)
})
