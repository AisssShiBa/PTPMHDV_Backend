import { randomUUID } from 'crypto'
import {
  Notification,
  NotificationType,
  NotificationTypeValue
} from '../types/notification'

export const MOCK_USER_ID = '6f9619ff-8b86-d011-b42d-00cf4fc964ff'

export const mockNotifications: Notification[] = [
  {
    id: '550e8400-e29b-41d4-a716-446655440000',
    userId: MOCK_USER_ID,
    type: NotificationType.PAYMENT_SUCCESS,
    message: 'Giao dịch #PAY-20260913-001 đã thanh toán thành công',
    read: false,
    createdAt: '2026-09-13T10:15:00.000Z'
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440001',
    userId: MOCK_USER_ID,
    type: NotificationType.PAYMENT_FAILED,
    message: 'Giao dịch #PAY-20260913-002 thất bại do số dư không đủ',
    read: false,
    createdAt: '2026-09-13T09:40:00.000Z'
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440002',
    userId: MOCK_USER_ID,
    type: NotificationType.KYC_APPROVED,
    message: 'Hồ sơ KYC của bạn đã được duyệt',
    read: true,
    createdAt: '2026-09-12T14:20:00.000Z'
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440003',
    userId: MOCK_USER_ID,
    type: NotificationType.MERCHANT_APPROVED,
    message: 'Cửa hàng SHOP VÍP của bạn đã được duyệt hoạt động',
    read: false,
    createdAt: '2026-09-11T08:05:00.000Z'
  }
]

export function findByUserId(userId: string): Notification[] {
  return mockNotifications.filter((item) => item.userId === userId)
}

export function markRead(id: string): Notification | null {
  const target = mockNotifications.find((item) => item.id === id)
  if (!target) {
    return null
  }
  target.read = true
  return target
}

export function markAllRead(userId: string): number {
  let updatedCount = 0
  for (const item of mockNotifications) {
    if (item.userId === userId && !item.read) {
      item.read = true
      updatedCount++
    }
  }
  return updatedCount
}

export function createMockNotification(input: {
  userId: string
  type: NotificationTypeValue
  message: string
}): Notification {
  const notification: Notification = {
    id: randomUUID(),
    userId: input.userId,
    type: input.type,
    message: input.message,
    read: false,
    createdAt: new Date().toISOString()
  }
  mockNotifications.unshift(notification)
  return notification
}