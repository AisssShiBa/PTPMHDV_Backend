import cron from 'node-cron'
import { createSingleFlight } from 'finvault-events'
import { OutboxEventStatus } from '../utils/enums'
import { prisma } from '../utils/prisma'
import { NotificationClient } from '../clients/notification.client'
import { publish } from '../utils/rabbitmq.publisher'
import {
  createPaymentFinvaultPublisher
} from '../events/finvault.publisher'
import { processPaymentOutboxEvent } from './payment-outbox-event'

const legacyRoutingKey = 'payment.notification'
const notificationClient = new NotificationClient()
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

async function drainPendingOutbox(): Promise<void> {
  await prisma.$transaction(async tx => {
    const now = new Date()
    const claimed = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "OutboxEvent"
      WHERE "status" = 'PENDING'
        AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= ${now})
      ORDER BY "createdAt" ASC
      LIMIT 50
      FOR UPDATE SKIP LOCKED
    `
    if (claimed.length === 0) return

    const events = await tx.outboxEvent.findMany({
      where: { id: { in: claimed.map(row => row.id) } },
      orderBy: { createdAt: 'asc' }
    })

    for (const event of events) {
      const payload = event.payload as Record<string, unknown>
      try {
        const finvaultResult = await processPaymentOutboxEvent(event, {
          publish: finvaultEvent => getFinvaultPublisher().publish(finvaultEvent),
          markSent: async () => {
            await tx.outboxEvent.update({
              where: { id: event.id },
              data: { status: OutboxEventStatus.SENT, sentAt: new Date() }
            })
          },
          markFailed: async () => {
            await tx.outboxEvent.update({
              where: { id: event.id },
              data: { status: OutboxEventStatus.FAILED }
            })
          },
          scheduleRetry: async delayMs => {
            await tx.outboxEvent.update({
              where: { id: event.id },
              data: {
                retryCount: { increment: 1 },
                nextRetryAt: new Date(Date.now() + delayMs)
              }
            })
          }
        })
        if (finvaultResult !== 'unhandled') {
          continue
        }

        const message = legacyMessage(event.eventType, payload)
        if (!message) {
          await tx.outboxEvent.update({
            where: { id: event.id },
            data: { status: OutboxEventStatus.SENT, sentAt: new Date() }
          })
          continue
        }

        const userId = typeof payload.userId === 'string' ? payload.userId : ''
        if (!userId) throw new TypeError('Legacy payment outbox payload is missing userId')
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

        if (!sent) {
          await notificationClient.send(userId, event.eventType, message, event.id)
        }

        await tx.outboxEvent.update({
          where: { id: event.id },
          data: { status: OutboxEventStatus.SENT, sentAt: new Date() }
        })
      } catch (error) {
        const axiosError = error as { response?: { status?: number }; message?: string }
        console.error('[Payment Outbox] Legacy notification publish failed', {
          eventId: event.id,
          eventType: event.eventType,
          status: axiosError.response?.status
        })
        const retryCount = event.retryCount + 1
        if (axiosError.response?.status && axiosError.response.status >= 400 &&
            axiosError.response.status < 500) {
          await tx.outboxEvent.update({
            where: { id: event.id },
            data: { status: OutboxEventStatus.FAILED, retryCount }
          })
        } else if (retryCount >= 5) {
          await tx.outboxEvent.update({
            where: { id: event.id },
            data: { status: OutboxEventStatus.FAILED, retryCount }
          })
        } else {
          await tx.outboxEvent.update({
            where: { id: event.id },
            data: {
              retryCount,
              nextRetryAt: new Date(Date.now() + Math.min(30_000, 2 ** retryCount * 1000))
            }
          })
        }
      }
    }
  }, { maxWait: 15000, timeout: 120000 })
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
