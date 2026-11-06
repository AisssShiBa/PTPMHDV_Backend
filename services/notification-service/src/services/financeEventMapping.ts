import type { FinvaultEvent } from 'finvault-events'
import type { NotificationTypeValue } from './notificationService'
import { shortenDisplayName } from './userLookup'

export type FinanceNotificationDraft = {
  userId: string
  type: NotificationTypeValue
  message: string
}

const eventData = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('FinVault event data must be an object')
  }
  return value as Record<string, unknown>
}

const requiredString = (data: Record<string, unknown>, key: string): string => {
  const value = data[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`FinVault event data is missing ${key}`)
  }
  return value
}

const requiredTier = (data: Record<string, unknown>, key: string): number => {
  const value = data[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2) {
    throw new TypeError(`FinVault event data has an invalid ${key}`)
  }
  return value
}

const formatAmount = (amount: bigint): string =>
  `${new Intl.NumberFormat('vi-VN').format(amount)}đ`

// Funding/payment/utility events carry an integer VND string. Rejecting the
// value here (TypeError) turns a malformed event into a non-retryable failure.
const integerAmount = (data: Record<string, unknown>, key = 'amount'): bigint => {
  const value = data[key]
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new TypeError(`FinVault event data has an invalid ${key}`)
  }
  return BigInt(value)
}

// Refund payloads may be decimal strings such as "50000.00". Only a zero
// fractional part is accepted; VND has no meaningful subunit here.
const decimalVndAmount = (data: Record<string, unknown>, key = 'amount'): bigint => {
  const value = data[key]
  if (typeof value !== 'string' || !/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new TypeError(`FinVault event data has an invalid ${key}`)
  }
  const [whole, fraction = ''] = value.split('.')
  if (fraction.replace(/0/g, '').length > 0) {
    throw new TypeError(`FinVault event data has an invalid ${key}`)
  }
  return BigInt(whole)
}

const sanitizeReason = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  // Strip control characters (newlines, tabs, NUL, ...) before showing a
  // provider/user supplied reason in a notification.
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(cleaned).slice(0, 200).join('')
}

const withNote = (message: string, data: Record<string, unknown>): string => {
  const note = typeof data.note === 'string' ? data.note.trim() : ''
  return note ? `${message.replace(/[.!?]+$/, '')}. Ghi chú: ${note}` : message
}

export function paymentCounterpartyIds(event: FinvaultEvent): [string, string] {
  const data = eventData(event.data)
  return [requiredString(data, 'senderId'), requiredString(data, 'receiverId')]
}

export function mapFinanceEventToNotifications(
  event: FinvaultEvent,
  userNames: ReadonlyMap<string, string> = new Map()
): FinanceNotificationDraft[] {
  const data = eventData(event.data)

  switch (event.eventType) {
    case 'user.kyc_updated': {
      const userId = requiredString(data, 'authUserId')
      const currentTier = requiredTier(data, 'kycTier')
      const hasPreviousTier = data.legacy !== true && data.previousTier !== undefined
      const message = hasPreviousTier
        ? `Cấp xác thực của bạn đã chuyển từ cấp ${requiredTier(data, 'previousTier')} lên cấp ${currentTier}.`
        : `Cấp xác thực của bạn đã được cập nhật lên cấp ${currentTier}.`
      return [{ userId, type: 'KYC_TIER_CHANGED', message }]
    }
    case 'payment.succeeded': {
      const [senderId, receiverId] = paymentCounterpartyIds(event)
      const amount = formatAmount(integerAmount(data))
      if (senderId === receiverId) {
        return [{
          userId: senderId,
          type: 'PAYMENT_SUCCESS',
          message: withNote(`Giao dịch thanh toán ${amount} đã thành công`, data)
        }]
      }
      const displayName = (userId: string) => {
        const name = shortenDisplayName(userNames.get(userId))
        return name === 'một người dùng' ? `${name}.` : name
      }
      const receiverName = displayName(receiverId)
      const senderName = displayName(senderId)
      return [
        {
          userId: senderId,
          type: 'PAYMENT_SUCCESS',
          message: withNote(`Bạn đã chuyển ${amount} cho ${receiverName}`, data)
        },
        {
          userId: receiverId,
          type: 'PAYMENT_SUCCESS',
          message: withNote(`Bạn nhận ${amount} từ ${senderName}`, data)
        }
      ]
    }
    case 'payment.failed':
      return [{
        userId: requiredString(data, 'senderId'),
        type: 'PAYMENT_FAILED',
        message: 'Giao dịch thanh toán của bạn không thành công.'
      }]
    case 'payment.expired':
      return [{
        userId: requiredString(data, 'senderId'),
        type: 'PAYMENT_EXPIRED',
        message: 'Giao dịch thanh toán của bạn đã hết hạn.'
      }]
    case 'funding.topup_succeeded':
      return [{
        userId: requiredString(data, 'userId'),
        type: 'TOPUP_SUCCEEDED',
        message: `Bạn đã nạp ${formatAmount(integerAmount(data))} vào ví thành công.`
      }]
    case 'payment.refunded':
      return [{
        userId: requiredString(data, 'userId'),
        type: 'PAYMENT_REFUNDED',
        message: `Bạn được hoàn ${formatAmount(decimalVndAmount(data))} vào ví.`
      }]
    case 'funding.cashout_completed':
      return [{
        userId: requiredString(data, 'userId'),
        type: 'CASHOUT_SUCCEEDED',
        message: `Lệnh rút ${formatAmount(integerAmount(data))} của bạn đã thành công.`
      }]
    case 'funding.cashout_failed':
      // Deliberately ignore any upstream reason: it may contain internal or
      // sensitive details.
      return [{
        userId: requiredString(data, 'userId'),
        type: 'CASHOUT_FAILED',
        message: `Lệnh rút ${formatAmount(integerAmount(data))} của bạn không thành công.`
      }]
    case 'utility.order_succeeded':
      return [{
        userId: requiredString(data, 'userId'),
        type: 'UTILITY_SUCCEEDED',
        message: `Giao dịch tiện ích ${formatAmount(integerAmount(data))} đã thành công.`
      }]
    case 'utility.order_failed':
      return [{
        userId: requiredString(data, 'userId'),
        type: 'UTILITY_FAILED',
        message: `Giao dịch tiện ích ${formatAmount(integerAmount(data))} không thành công.`
      }]
    case 'utility.order_refunded':
      return [{
        userId: requiredString(data, 'userId'),
        type: 'UTILITY_REFUNDED',
        message: `Giao dịch tiện ích ${formatAmount(integerAmount(data))} đã được hoàn tiền.`
      }]
    case 'user.kyc_reviewed': {
      const userId = requiredString(data, 'authUserId')
      if (data.status === 'APPROVED') {
        return [{
          userId,
          type: 'KYC_APPROVED',
          message: 'Hồ sơ xác thực của bạn đã được duyệt.'
        }]
      }
      if (data.status === 'REJECTED') {
        const reason = sanitizeReason(data.reason)
        return [{
          userId,
          type: 'KYC_REJECTED',
          message: reason
            ? `Hồ sơ xác thực bị từ chối. Lý do: ${reason}.`
            : 'Hồ sơ xác thực bị từ chối.'
        }]
      }
      throw new TypeError('FinVault event data has an invalid status')
    }
    default:
      return []
  }
}
