import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { prisma } from '../src/config/prisma'
import { decideRetry, parseEvent } from '../src/services/rabbitmqConsumer'
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

test('consumer parses a flat event and falls back to AMQP messageId', () => {
  const event = parseEvent({
    content: Buffer.from(JSON.stringify(notificationPayload)),
    properties: { messageId: 'flat-message-id' }
  })

  assert.equal(event.eventId, 'flat-message-id')
  assert.equal(event.userId, notificationPayload.userId)
  assert.equal(event.type, notificationPayload.type)
  assert.equal(event.message, notificationPayload.message)
})

test('consumer parses an envelope event using its eventType and data', () => {
  const event = parseEvent({
    content: Buffer.from(JSON.stringify({
      eventId: 'envelope-event-id',
      eventType: 'PAYMENT_EXPIRED',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      data: notificationPayload
    })),
    properties: { messageId: 'amqp-message-id' }
  })

  assert.equal(event.eventId, 'envelope-event-id')
  assert.equal(event.type, 'PAYMENT_EXPIRED')
  assert.equal(event.userId, notificationPayload.userId)
})

test('consumer falls back to AMQP messageId when body.eventId is missing', () => {
  const event = parseEvent({
    content: Buffer.from(JSON.stringify({ payload: notificationPayload })),
    properties: { messageId: 'amqp-message-id' }
  })

  assert.equal(event.eventId, 'amqp-message-id')
})

test('consumer rejects an event without a user ID', () => {
  assert.throws(
    () => parseEvent({
      content: Buffer.from(JSON.stringify({
        type: 'PAYMENT_EXPIRED',
        message: 'Payment expired'
      })),
      properties: {}
    }),
    { name: 'InvalidNotificationEventError' }
  )
})

test('temporary failures retry three times before the fourth delivery goes to DLQ', () => {
  assert.deepEqual(decideRetry(0), { action: 'retry', retryCount: 1 })
  assert.deepEqual(decideRetry(1), { action: 'retry', retryCount: 2 })
  assert.deepEqual(decideRetry(2), { action: 'retry', retryCount: 3 })
  assert.deepEqual(decideRetry(3), { action: 'dead-letter' })
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

test('notification inbox deduplicates twenty concurrent deliveries', async () => {
  const eventId = `notification-event-${randomUUID()}`
  try {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        ingestNotification({
          ...notificationPayload,
          eventId,
          source: 'payment.events'
        })
      )
    )

    assert.equal(results.filter((result) => !result.duplicate).length, 1)
    assert.equal(results.filter((result) => result.duplicate).length, 19)
    assert.equal(await prisma.notification.count({ where: { eventId } }), 1)
    assert.equal(await prisma.notificationInbox.count({ where: { eventId } }), 1)
  } finally {
    await prisma.notificationInbox.deleteMany({ where: { eventId } })
    await prisma.notification.deleteMany({ where: { eventId } })
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
