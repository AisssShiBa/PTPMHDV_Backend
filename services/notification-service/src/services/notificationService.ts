import { prisma } from '../config/prisma'
import { NotificationType } from '../types/notification'

export type NotificationTypeValue = (typeof NotificationType)[keyof typeof NotificationType]

export const isNotificationType = (value: unknown): value is NotificationTypeValue =>
  typeof value === 'string' && Object.values(NotificationType).includes(value as NotificationTypeValue)

export const createNotificationRecord = async (
  userId: string,
  type: NotificationTypeValue,
  message: string
) => prisma.notification.create({ data: { userId, type, message } })