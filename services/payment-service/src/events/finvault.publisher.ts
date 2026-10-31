import { createEventFromOutbox, createPublisher, parseFinvaultEvent, type FinvaultEvent } from 'finvault-events'
import type { OutboxEvent, Prisma } from '@prisma/client'

type PaymentOutbox = Pick<OutboxEvent, 'id' | 'createdAt' | 'eventType' | 'aggregateId' | 'payload'>

const isRecord = (value: Prisma.JsonValue): value is Prisma.JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function requiredString(data: Prisma.JsonObject, key: string): string {
  const value = data[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`Payment outbox payload is missing ${key}`)
  }
  return value
}

function amountString(value: Prisma.JsonValue | undefined): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TypeError('Payment outbox amount must be a decimal string')
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new TypeError('Payment outbox amount must be an exact integer')
  }
  const match = /^(\d+)(?:\.0+)?$/.exec(String(value))
  if (!match) throw new TypeError('Payment amount must be a whole VND value')
  return match[1]
}

export function buildPaymentFinvaultEvent(row: PaymentOutbox): FinvaultEvent | undefined {
  if (!isRecord(row.payload)) throw new TypeError('Payment outbox payload must be an object')
  const payload = row.payload
  // Huu's durable P2P workflow already stores the complete event envelope.
  // Keep its stable ID while using main's leased outbox and retry handling.
  if (row.eventType.startsWith('payment.')) {
    const event = parseFinvaultEvent(payload)
    if (event.eventId !== row.id || event.eventType !== row.eventType ||
        (event.data as Record<string, unknown>).paymentId !== row.aggregateId) {
      throw new TypeError('Payment event envelope does not match its outbox row')
    }
    return event
  }
  const senderId = requiredString(payload, 'userId')
  const paymentId = typeof payload.id === 'string' && payload.id.length > 0
    ? payload.id
    : row.aggregateId

  switch (row.eventType) {
    case 'PAYMENT_SUCCESS': {
      const receiverId = typeof payload.destinationUserId === 'string' && payload.destinationUserId.length > 0
        ? payload.destinationUserId
        : senderId
      const data: Record<string, string> = {
        paymentId,
        senderId,
        receiverId,
        amount: amountString(payload.amount)
      }
      if (typeof payload.note === 'string' && payload.note.trim()) {
        data.note = payload.note.trim()
      }
      return createEventFromOutbox(row, 'payment.succeeded', data)
    }
    case 'PAYMENT_FAILED': {
      const reason = typeof payload.failureReason === 'string' && payload.failureReason.trim()
        ? payload.failureReason.trim()
        : 'PAYMENT_FAILED'
      return createEventFromOutbox(row, 'payment.failed', { paymentId, senderId, reason })
    }
    case 'PAYMENT_EXPIRED':
      return createEventFromOutbox(row, 'payment.expired', { paymentId, senderId })
    default:
      return undefined
  }
}

export function createPaymentFinvaultPublisher(url = process.env.RABBITMQ_URL) {
  if (!url) throw new Error('RABBITMQ_URL is required for FinVault event publishing')
  const publisher = createPublisher({ url })
  return {
    publish(event: FinvaultEvent) {
      return publisher.publish(event)
    },
    close() {
      return publisher.close()
    }
  }
}
