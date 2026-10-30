import cron from 'node-cron'
import { createSingleFlight } from 'finvault-events'
import { OutboxEventStatus } from '../utils/enums'
import { prisma } from '../utils/prisma'
import { NotificationClient } from '../clients/notification.client'
import { publish } from '../utils/rabbitmq.publisher'
import { createPaymentFinvaultPublisher } from '../events/finvault.publisher'
import { claimPaymentOutboxEvents } from './payment-outbox-claim'
import { paymentRetryDelayMs, processPaymentOutboxEvent } from './payment-outbox-event'

const legacyRoutingKey = 'payment.notification'
const notificationClient = new NotificationClient()
const MAX_LEGACY_RETRIES = 10
let finvaultPublisher: ReturnType<typeof createPaymentFinvaultPublisher> | undefined

const getFinvaultPublisher = () => {
  if (!finvaultPublisher) finvaultPublisher = createPaymentFinvaultPublisher()
  return finvaultPublisher
}

function legacyMessage(eventType: string, payload: Record<string, unknown>): string | undefined {
  if (eventType === 'PAYMENT_REFUNDED') {
    return `Thanh toán đã được hoàn tiền ${String(payload.amount ?? '')} VND.`
  }
  if (eventType === 'PAYMENT_CANCELLED') return 'Thanh toán đã bị hủy.'
  return undefined
}

async function updateClaimed(
  id: string,
  lockToken: string,
  data: Parameters<typeof prisma.outboxEvent.updateMany>[0]['data']
): Promise<void> {
  await prisma.outboxEvent.updateMany({
    where: { id, status: OutboxEventStatus.PROCESSING, lockToken },
    data: { ...data, lockedUntil: null, lockToken: null }
  })
}

async function processClaimedEvent(id: string, lockToken: string): Promise<void> {
  const event = await prisma.outboxEvent.findFirst({
    where: { id, status: OutboxEventStatus.PROCESSING, lockToken }
  })
  if (!event) return

  const payload = event.payload as Record<string, unknown>
  const finvaultResult = await processPaymentOutboxEvent(event, {
    publish: finvaultEvent => getFinvaultPublisher().publish(finvaultEvent),
    markSent: () => updateClaimed(id, lockToken, {
      status: OutboxEventStatus.SENT,
      sentAt: new Date()
    }),
    markFailed: () => updateClaimed(id, lockToken, {
      status: OutboxEventStatus.FAILED
    }),
    scheduleRetry: delayMs => updateClaimed(id, lockToken, {
      status: OutboxEventStatus.PENDING,
      retryCount: { increment: 1 },
      nextRetryAt: new Date(Date.now() + delayMs)
    })
  })
  if (finvaultResult !== 'unhandled') return

  const message = legacyMessage(event.eventType, payload)
  if (!message) {
    await updateClaimed(id, lockToken, {
      status: OutboxEventStatus.SENT,
      sentAt: new Date()
    })
    return
  }

  const userId = typeof payload.userId === 'string' ? payload.userId : ''
  if (!userId.trim()) {
    console.error('[Payment Outbox] Invalid legacy event data; marking row FAILED', {
      eventId: event.id,
      eventType: event.eventType
    })
    await updateClaimed(id, lockToken, { status: OutboxEventStatus.FAILED })
    return
  }

  const legacyPayload = { eventId: event.id, userId, type: event.eventType, message }
  let sent = false
  try {
    sent = await publish(
      'payment.events',
      event.eventType === 'PAYMENT_EXPIRED' ? 'payment.expired' : legacyRoutingKey,
      legacyPayload,
      { messageId: event.id }
    )
  } catch {
    sent = false
  }

  try {
    if (!sent) await notificationClient.send(userId, event.eventType, message, event.id)
    await updateClaimed(id, lockToken, {
      status: OutboxEventStatus.SENT,
      sentAt: new Date()
    })
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response?.status
    const nextRetryCount = event.retryCount + 1
    console.error('[Payment Outbox] Legacy notification delivery failed', {
      eventId: event.id,
      eventType: event.eventType,
      status
    })
    if ((status !== undefined && status >= 400 && status < 500) ||
        nextRetryCount >= MAX_LEGACY_RETRIES) {
      await updateClaimed(id, lockToken, {
        status: OutboxEventStatus.FAILED,
        retryCount: nextRetryCount
      })
      return
    }

    await updateClaimed(id, lockToken, {
      status: OutboxEventStatus.PENDING,
      retryCount: nextRetryCount,
      nextRetryAt: new Date(Date.now() + paymentRetryDelayMs(event.retryCount))
    })
  }
}

async function drainPendingOutbox(): Promise<void> {
  const claimed = await claimPaymentOutboxEvents(prisma)
  for (const event of claimed) {
    try {
      // Publishing happens after the short claim transaction. If a worker dies,
      // the lease expires and the stable eventId permits safe at-least-once retry.
      await processClaimedEvent(event.id, event.lockToken)
    } catch (error) {
      console.error('[Payment Outbox] Claimed event processing failed', {
        eventId: event.id,
        error: error instanceof Error ? error.message : 'unknown error'
      })
      await updateClaimed(event.id, event.lockToken, {
        status: OutboxEventStatus.PENDING,
        retryCount: { increment: 1 },
        nextRetryAt: new Date(Date.now() + 1000)
      }).catch(updateError => {
        console.error('[Payment Outbox] Could not release failed event lease', {
          eventId: event.id,
          error: updateError instanceof Error ? updateError.message : 'unknown error'
        })
      })
    }
  }
}

const runDrain = createSingleFlight(drainPendingOutbox)

export function drainOutbox(): Promise<void> {
  return runDrain()
}

export async function closeFinvaultOutboxPublisher(): Promise<void> {
  const publisher = finvaultPublisher
  finvaultPublisher = undefined
  await publisher?.close()
}

export const startOutboxJob = () => {
  cron.schedule('*/1 * * * * *', () => {
    void drainOutbox().catch(error => {
      console.error('[Payment Outbox] Drain failed', error instanceof Error ? error.message : 'unknown error')
    })
  })
  void drainOutbox().catch(error => {
    console.error('[Payment Outbox] Initial drain failed', error instanceof Error ? error.message : 'unknown error')
  })
  console.log('Outbox Job started (runs every second)')
}
