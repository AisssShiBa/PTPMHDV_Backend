import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { prisma } from '../src/config/prisma'
import { parseEvent } from '../src/services/rabbitmqConsumer'
import {
  ingestNotification,
  isNotificationType,
  NotificationIngestError
} from '../src/services/notificationService'

const notificationPayload = {
  userId: `notification-inbox-user-${randomUUID()}`,
  type: 'PAYMENT_EXPIRED' as const,
  message: 'Payment expired'
}

test('consumer uses body.eventId before AMQP messageId', () => {
  const event = parseEvent({
    content: Buffer.from(JSON.stringify({
      eventId: 'body-event-id',
      data: notificationPayload
    })),
    properties: { messageId: 'amqp-message-id' }
  })

  assert.equal(event.eventId, 'body-event-id')
  assert.equal(event.type, 'PAYMENT_EXPIRED')
  assert.equal(isNotificationType('KYC_TIER_CHANGED'), true)
})

test('consumer falls back to AMQP messageId when body.eventId is missing', () => {
  const event = parseEvent({
    content: Buffer.from(JSON.stringify({ payload: notificationPayload })),
    properties: { messageId: 'amqp-message-id' }
  })

  assert.equal(event.eventId, 'amqp-message-id')
})

test('notification inbox deduplicates identical event deliveries', async () => {
  const eventId = `notification-event-${randomUUID()}`
  let created = false
  try {
    const first = await ingestNotification({
      ...notificationPayload,
      eventId,
      source: 'payment.events'
    })
    created = true
    const duplicate = await ingestNotification({
      ...notificationPayload,
      eventId,
      source: 'payment.events'
    })

    assert.equal(first.duplicate, false)
    assert.equal(duplicate.duplicate, true)
    assert.equal(await prisma.notification.count({ where: { eventId } }), 1)
  } finally {
    if (created) {
      await prisma.notificationInbox.deleteMany({ where: { eventId } })
      await prisma.notification.deleteMany({ where: { eventId } })
    }
  }
})

test('notification inbox rejects reuse of an eventId with different content', async () => {
  const eventId = `notification-event-${randomUUID()}`
  let created = false
  try {
    await ingestNotification({ ...notificationPayload, eventId, source: 'payment.events' })
    created = true

    await assert.rejects(
      ingestNotification({
        ...notificationPayload,
        eventId,
        message: 'Different message',
        source: 'payment.events'
      }),
      (error: unknown) => error instanceof NotificationIngestError && error.code === 'EVENT_CONFLICT'
    )
  } finally {
    if (created) {
      await prisma.notificationInbox.deleteMany({ where: { eventId } })
      await prisma.notification.deleteMany({ where: { eventId } })
    }
  }
})
