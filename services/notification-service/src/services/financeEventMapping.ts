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

const formatAmount = (amount: string): string =>
  `${new Intl.NumberFormat('vi-VN').format(BigInt(amount))}đ`

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
      const amount = formatAmount(requiredString(data, 'amount'))
      if (senderId === receiverId) {
        return [{
          userId: senderId,
          type: 'PAYMENT_SUCCESS',
          message: `Giao dịch thanh toán ${amount} đã thành công.`
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
          message: `Bạn đã chuyển ${amount} cho ${receiverName}`
        },
        {
          userId: receiverId,
          type: 'PAYMENT_SUCCESS',
          message: `Bạn nhận ${amount} từ ${senderName}`
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
    default:
      return []
  }
}
