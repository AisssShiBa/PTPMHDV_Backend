import { prisma } from '../config/prisma'
import { NotificationType } from '../types/notification'
import { createHash } from 'node:crypto'

export type NotificationTypeValue = (typeof NotificationType)[keyof typeof NotificationType]

export const isNotificationType = (value: unknown): value is NotificationTypeValue =>
  typeof value === 'string' && Object.values(NotificationType).includes(value as NotificationTypeValue)

export type IngestNotificationInput = {
  eventId?: string
  userId: string
  type: NotificationTypeValue
  message: string
  source: string
}

export class NotificationIngestError extends Error {
  constructor(public readonly code: 'EVENT_CONFLICT' | 'INVALID_NOTIFICATION', message: string) {
    super(message)
    this.name = 'NotificationIngestError'
  }
}

export const ingestNotification = async ({
  eventId,
  userId,
  type,
  message,
  source
}: IngestNotificationInput) => {
  if (
    typeof userId !== 'string' ||
    userId.trim().length === 0 ||
    !isNotificationType(type) ||
    typeof message !== 'string' ||
    typeof source !== 'string' ||
    source.trim().length === 0 ||
    (eventId !== undefined && (typeof eventId !== 'string' || eventId.trim().length === 0))
  ) {
    throw new NotificationIngestError('INVALID_NOTIFICATION', 'Invalid notification payload')
  }

  if (eventId === undefined) {
    console.warn('[Notification] Thiếu eventId, không thể chống trùng')
    const notification = await prisma.notification.create({ data: { userId, type, message } })
    return { duplicate: false, notification }
  }

  const payloadHash = createHash('sha256')
    .update(JSON.stringify({ userId, type, message }))
    .digest('hex')

  return prisma.$transaction(async (tx) => {
    const inserted = await tx.$executeRaw`
      INSERT INTO "NotificationInbox" ("eventId", "source", "payloadHash")
      VALUES (${eventId}, ${source}, ${payloadHash})
      ON CONFLICT ("eventId") DO NOTHING
    `

    if (inserted === 0) {
      const inboxRows = await tx.$queryRaw<Array<{ payloadHash: string }>>`
        SELECT "payloadHash"
        FROM "NotificationInbox"
        WHERE "eventId" = ${eventId}
      `
      const existingInbox = inboxRows[0]
      if (!existingInbox) {
        throw new Error('Notification inbox row disappeared during duplicate check')
      }
      if (existingInbox.payloadHash !== payloadHash) {
        throw new NotificationIngestError('EVENT_CONFLICT', 'Event ID was reused with different data')
      }
      return { duplicate: true }
    }

    const notification = await tx.notification.create({
      data: { eventId, userId, type, message }
    })
    return { duplicate: false, notification }
  })
}