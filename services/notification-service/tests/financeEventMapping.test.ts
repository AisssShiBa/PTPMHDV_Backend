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
        message: 'Bạn đã chuyển 50.000đ cho một người dùng.'
      },
      {
        userId: 'receiver',
        type: 'PAYMENT_SUCCESS',
        message: 'Bạn nhận 50.000đ từ một người dùng.'
      }
    ]
  )
})

test('payment.succeeded personalizes sender and receiver messages with compacted names', () => {
  assert.deepEqual(
    mapFinanceEventToNotifications(event('payment.succeeded', {
      paymentId: 'payment-1',
      senderId: 'sender',
      receiverId: 'receiver',
      amount: '50000'
    }), new Map([
      ['sender', 'Nguyễn Văn An'],
      ['receiver', 'Trần Thị Bình']
    ])),
    [
      {
        userId: 'sender',
        type: 'PAYMENT_SUCCESS',
        message: 'Bạn đã chuyển 50.000đ cho Trần B.'
      },
      {
        userId: 'receiver',
        type: 'PAYMENT_SUCCESS',
        message: 'Bạn nhận 50.000đ từ Nguyễn A.'
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

test('payment.succeeded includes an optional note in both recipient messages', () => {
  const notifications = mapFinanceEventToNotifications(event('payment.succeeded', {
    paymentId: 'payment-1',
    senderId: 'sender',
    receiverId: 'receiver',
    amount: '50000',
    note: 'Bữa tối'
  }))

  assert.equal(notifications.length, 2)
  assert.ok(notifications.every(notification => notification.message.endsWith('Ghi chú: Bữa tối')))
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

// N14a: enum + mapping only. These event types are NOT registered in
// packages/finvault-events yet, so the consumer must not bind them (N14b).
test('funding.topup_succeeded maps to TOPUP_SUCCEEDED with a BigInt-formatted amount', () => {
  assert.deepEqual(
    mapFinanceEventToNotifications(event('funding.topup_succeeded', {
      userId: 'user-1',
      amount: '50000'
    })),
    [{
      userId: 'user-1',
      type: 'TOPUP_SUCCEEDED',
      message: 'Bạn đã nạp 50.000đ vào ví thành công.'
    }]
  )
})

test('payment.refunded accepts "50000.00" and rejects a non-zero fractional part', () => {
  assert.deepEqual(
    mapFinanceEventToNotifications(event('payment.refunded', {
      userId: 'receiver-1',
      amount: '50000.00'
    })),
    [{
      userId: 'receiver-1',
      type: 'PAYMENT_REFUNDED',
      message: 'Bạn được hoàn 50.000đ vào ví.'
    }]
  )

  assert.throws(
    () => mapFinanceEventToNotifications(event('payment.refunded', {
      userId: 'receiver-1',
      amount: '50000.50'
    })),
    TypeError
  )
})

test('funding cashout events map to CASHOUT_SUCCEEDED/CASHOUT_FAILED without exposing a reason', () => {
  assert.deepEqual(
    mapFinanceEventToNotifications(event('funding.cashout_completed', {
      userId: 'user-1',
      amount: '200000'
    })),
    [{
      userId: 'user-1',
      type: 'CASHOUT_SUCCEEDED',
      message: 'Lệnh rút 200.000đ của bạn đã thành công.'
    }]
  )

  const [failed] = mapFinanceEventToNotifications(event('funding.cashout_failed', {
    userId: 'user-1',
    amount: '200000',
    reason: 'internal bank token rejected'
  }))
  assert.equal(failed.type, 'CASHOUT_FAILED')
  assert.equal(failed.userId, 'user-1')
  assert.equal(failed.message, 'Lệnh rút 200.000đ của bạn không thành công.')
  assert.equal(failed.message.includes('internal bank token rejected'), false)
})

test('utility order events map to UTILITY_SUCCEEDED/FAILED/REFUNDED', () => {
  const cases: Array<[string, string, string]> = [
    ['utility.order_succeeded', 'UTILITY_SUCCEEDED', 'Giao dịch tiện ích 50.000đ đã thành công.'],
    ['utility.order_failed', 'UTILITY_FAILED', 'Giao dịch tiện ích 50.000đ không thành công.'],
    ['utility.order_refunded', 'UTILITY_REFUNDED', 'Giao dịch tiện ích 50.000đ đã được hoàn tiền.']
  ]

  for (const [eventType, type, message] of cases) {
    assert.deepEqual(
      mapFinanceEventToNotifications(event(eventType, {
        userId: 'user-1',
        amount: '50000',
        type: 'TELCO_TOPUP'
      })),
      [{ userId: 'user-1', type, message }]
    )
  }
})

test('user.kyc_reviewed maps APPROVED and REJECTED, omitting an empty reason', () => {
  assert.deepEqual(
    mapFinanceEventToNotifications(event('user.kyc_reviewed', {
      authUserId: 'user-1',
      status: 'APPROVED'
    })),
    [{
      userId: 'user-1',
      type: 'KYC_APPROVED',
      message: 'Hồ sơ xác thực của bạn đã được duyệt.'
    }]
  )

  const [missingReason] = mapFinanceEventToNotifications(event('user.kyc_reviewed', {
    authUserId: 'user-1',
    status: 'REJECTED'
  }))
  assert.equal(missingReason.type, 'KYC_REJECTED')
  assert.equal(missingReason.message, 'Hồ sơ xác thực bị từ chối.')
  assert.equal(missingReason.message.includes('Lý do'), false)

  const [withReason] = mapFinanceEventToNotifications(event('user.kyc_reviewed', {
    authUserId: 'user-1',
    status: 'REJECTED',
    reason: 'Ảnh chụp bị mờ'
  }))
  assert.equal(withReason.message, 'Hồ sơ xác thực bị từ chối. Lý do: Ảnh chụp bị mờ.')
})

test('KYC rejection reasons are sanitized and truncated to 200 characters', () => {
  const [sanitized] = mapFinanceEventToNotifications(event('user.kyc_reviewed', {
    authUserId: 'user-1',
    status: 'REJECTED',
    reason: 'Ảnh\nmờ\u0000 quá\tmờ'
  }))
  assert.equal(sanitized.message, 'Hồ sơ xác thực bị từ chối. Lý do: Ảnh mờ quá mờ.')

  const [truncated] = mapFinanceEventToNotifications(event('user.kyc_reviewed', {
    authUserId: 'user-1',
    status: 'REJECTED',
    reason: 'x'.repeat(500)
  }))
  assert.equal(
    truncated.message,
    `Hồ sơ xác thực bị từ chối. Lý do: ${'x'.repeat(200)}.`
  )
})

test('new mappings throw TypeError for a missing userId, invalid amount or invalid KYC status', () => {
  assert.throws(
    () => mapFinanceEventToNotifications(event('funding.topup_succeeded', { amount: '50000' })),
    TypeError
  )
  assert.throws(
    () => mapFinanceEventToNotifications(event('utility.order_succeeded', {
      amount: '50000'
    })),
    TypeError
  )

  for (const amount of ['12.5', '-1', 'abc', '']) {
    assert.throws(
      () => mapFinanceEventToNotifications(event('funding.topup_succeeded', {
        userId: 'user-1',
        amount
      })),
      TypeError,
      `amount=${amount}`
    )
  }

  assert.throws(
    () => mapFinanceEventToNotifications(event('user.kyc_reviewed', {
      authUserId: 'user-1',
      status: 'PENDING'
    })),
    TypeError
  )
})

test('unknown event types still return no notifications', () => {
  assert.deepEqual(
    mapFinanceEventToNotifications(event('something.else', { userId: 'user-1' })),
    []
  )
})
