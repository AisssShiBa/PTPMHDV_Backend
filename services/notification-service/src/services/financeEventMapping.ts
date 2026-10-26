import type { FinvaultEvent } from 'finvault-events'
import type { NotificationTypeValue } from './notificationService'

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

const formatAmount = (amount: string): string =>
  `${new Intl.NumberFormat('vi-VN').format(BigInt(amount))}đ`

export function mapFinanceEventToNotifications(event: FinvaultEvent): FinanceNotificationDraft[] {
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
      const senderId = requiredString(data, 'senderId')
      const receiverId = requiredString(data, 'receiverId')
      const message = `Giao dịch thanh toán ${formatAmount(requiredString(data, 'amount'))} đã thành công.`
      return [...new Set([senderId, receiverId])].map(userId => ({
        userId,
        type: 'PAYMENT_SUCCESS',
        message
      }))
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
    default:
      return []
  }
}
