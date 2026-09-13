export const NotificationType = {
  PAYMENT_SUCCESS: 'PAYMENT_SUCCESS',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  KYC_APPROVED: 'KYC_APPROVED',
  KYC_REJECTED: 'KYC_REJECTED',
  MERCHANT_APPROVED: 'MERCHANT_APPROVED',
  MERCHANT_REJECTED: 'MERCHANT_REJECTED'
} as const

export type NotificationTypeValue =
  (typeof NotificationType)[keyof typeof NotificationType]

export interface Notification {
  id: string
  userId: string
  type: NotificationTypeValue
  message: string
  read: boolean
  createdAt: string
}