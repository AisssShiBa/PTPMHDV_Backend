import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FinvaultEvent } from 'finvault-events'
import { mapFinanceEventToNotifications } from '../src/services/financeEventMapping'

const event = (eventType: string, data: unknown): FinvaultEvent => ({
  eventId: '00000000-0000-4000-8000-000000000001',
  eventType,
  eventVersion: 1,
  occurredAt: '2026-01-01T00:00:00.000Z',
  data
})

test('payment.succeeded creates one Vietnamese notification per distinct recipient and formats BigInt amounts', () => {
  assert.deepEqual(
    mapFinanceEventToNotifications(event('payment.succeeded', {
      paymentId: 'payment-1',
      senderId: 'sender',
      receiverId: 'receiver',
      amount: '50000'
    })),
    [
      {
        userId: 'sender',
        type: 'PAYMENT_SUCCESS',
        message: 'Giao dịch thanh toán 50.000đ đã thành công.'
      },
      {
        userId: 'receiver',
        type: 'PAYMENT_SUCCESS',
        message: 'Giao dịch thanh toán 50.000đ đã thành công.'
      }
    ]
  )
})

test('payment.succeeded deduplicates a recipient who is both sender and receiver', () => {
  assert.equal(
    mapFinanceEventToNotifications(event('payment.succeeded', {
      paymentId: 'payment-1',
      senderId: 'same-user',
      receiverId: 'same-user',
      amount: '50000'
    })).length,
    1
  )
})

test('legacy KYC event does not invent a previous tier', () => {
  assert.deepEqual(
    mapFinanceEventToNotifications(event('user.kyc_updated', {
      authUserId: 'user-1',
      kycTier: 2,
      legacy: true
    })),
    [{
      userId: 'user-1',
      type: 'KYC_TIER_CHANGED',
      message: 'Cấp xác thực của bạn đã được cập nhật lên cấp 2.'
    }]
  )
})

test('payment.failed does not expose the raw failure reason', () => {
  const [notification] = mapFinanceEventToNotifications(event('payment.failed', {
    paymentId: 'payment-1',
    senderId: 'sender',
    reason: 'internal database credentials leaked'
  }))

  assert.equal(notification.message.includes('internal database credentials leaked'), false)
  assert.equal(notification.message, 'Giao dịch thanh toán của bạn không thành công.')
})
