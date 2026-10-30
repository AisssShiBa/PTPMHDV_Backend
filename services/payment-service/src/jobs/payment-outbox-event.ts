import type { OutboxEvent } from '@prisma/client'
import { buildPaymentFinvaultEvent } from '../events/finvault.publisher'

type PaymentEventRow = Pick<OutboxEvent, 'id' | 'createdAt' | 'eventType' | 'aggregateId' | 'payload' | 'retryCount'>

export type PaymentEventResult = 'unhandled' | 'sent' | 'failed' | 'retry'

export type PaymentEventActions = {
  publish: (event: NonNullable<ReturnType<typeof buildPaymentFinvaultEvent>>) => Promise<void>
  markSent: () => Promise<void>
  markFailed: (error: unknown) => Promise<void>
  scheduleRetry: (delayMs: number) => Promise<void>
}

export const paymentRetryDelayMs = (retryCount: number): number =>
  Math.min(30_000, 1000 * 2 ** Math.min(retryCount, 5))

export async function processPaymentOutboxEvent(
  row: PaymentEventRow,
  actions: PaymentEventActions
): Promise<PaymentEventResult> {
  let event: ReturnType<typeof buildPaymentFinvaultEvent>
  try {
    event = buildPaymentFinvaultEvent(row)
  } catch (error) {
    console.error('[Payment Outbox] Invalid event data; marking row FAILED', {
      eventId: row.id,
      eventType: row.eventType
    })
    await actions.markFailed(error)
    return 'failed'
  }

  if (!event) return 'unhandled'

  try {
    await actions.publish(event)
  } catch {
    // Broker transport failures stay retryable without a terminal retry limit:
    // a prolonged RabbitMQ outage must not permanently lose committed events.
    await actions.scheduleRetry(paymentRetryDelayMs(row.retryCount))
    console.error('[Payment Outbox] FinVault publish failed; event remains pending', {
      eventId: row.id,
      eventType: row.eventType
    })
    return 'retry'
  }

  await actions.markSent()
  return 'sent'
}
