import { createConsumer, type EventConsumer, type FinvaultEvent } from 'finvault-events'
import { env } from '../config/env'
import { prisma } from '../config/prisma'
import { createUtilityInbox, type UtilityTransactionContext } from './utilityInbox'
import { fulfillPaidOrder } from './fulfillmentService'
import type { PaymentClient, ProviderClient } from '../types/utility'

export const utilityEventQueue = 'utilities.finvault.events'
export const utilityEventBindings = [
  'payment.succeeded',
  'payment.failed',
  'payment.expired'
] as const

export type UtilityEventDependencies = {
  paymentClient: PaymentClient
  providerClient: ProviderClient
}

const paymentIdFrom = (event: FinvaultEvent): string | undefined => {
  const data = event.data
  if (typeof data !== 'object' || data === null) return undefined
  const paymentId = (data as Record<string, unknown>).paymentId
  return typeof paymentId === 'string' && paymentId.length > 0 ? paymentId : undefined
}

export async function handleUtilityEvent(
  event: FinvaultEvent,
  context: { tx: unknown },
  dependencies: UtilityEventDependencies
): Promise<void> {
  const transaction = context.tx as UtilityTransactionContext
  const paymentId = paymentIdFrom(event)
  if (!paymentId) return

  const order = await transaction.prisma.utilityOrder.findUnique({ where: { paymentId } })
  // Payments that do not belong to a utilities order are acknowledged and
  // ignored; they are not errors and must not be retried forever.
  if (!order) return

  if (event.eventType === 'payment.succeeded') {
    const updated = await transaction.prisma.utilityOrder.updateMany({
      where: { id: order.id, status: 'PENDING_PAYMENT' },
      data: { status: 'PAID' }
    })
    if (updated.count === 0) return
    await transaction.prisma.utilityOrderHistory.create({
      data: {
        orderId: order.id,
        fromStatus: 'PENDING_PAYMENT',
        toStatus: 'PAID',
        note: 'PAYMENT_SUCCEEDED'
      }
    })
    transaction.afterCommit(() =>
      fulfillPaidOrder(order.id, dependencies.providerClient, dependencies.paymentClient)
    )
    return
  }

  const reason = event.eventType === 'payment.failed' ? 'PAYMENT_FAILED' : 'PAYMENT_EXPIRED'
  const updated = await transaction.prisma.utilityOrder.updateMany({
    where: { id: order.id, status: 'PENDING_PAYMENT' },
    data: { status: 'FAILED', failureReason: reason }
  })
  if (updated.count > 0) {
    await transaction.prisma.utilityOrderHistory.create({
      data: {
        orderId: order.id,
        fromStatus: 'PENDING_PAYMENT',
        toStatus: 'FAILED',
        note: reason
      }
    })
  }
}

export function createUtilityEventsConsumer(
  url: string,
  dependencies: UtilityEventDependencies,
  queue = utilityEventQueue
): EventConsumer {
  return createConsumer({
    url,
    queue,
    exchange: 'finvault.events',
    bindings: [...utilityEventBindings],
    logger: {
      info: (message, context) => console.info(`[Utilities events] ${message}`, context)
    },
    inbox: createUtilityInbox(prisma),
    handlers: {
      'payment.succeeded': (event, context) =>
        handleUtilityEvent(event, context, dependencies),
      'payment.failed': (event, context) => handleUtilityEvent(event, context, dependencies),
      'payment.expired': (event, context) => handleUtilityEvent(event, context, dependencies)
    }
  })
}

export type UtilityConsumerSupervisor = {
  whenStarted: Promise<boolean>
  stop(): Promise<void>
}

export function startUtilityEventsConsumer(
  dependencies: UtilityEventDependencies,
  url: string | undefined = env.rabbitmqUrl
): UtilityConsumerSupervisor | undefined {
  if (!url) {
    console.log('Utilities FinVault consumer disabled: RABBITMQ_URL is not configured')
    return undefined
  }

  let running = true
  let consumer: EventConsumer | undefined
  let resolveStarted!: (value: boolean) => void
  const whenStarted = new Promise<boolean>(resolve => {
    resolveStarted = resolve
  })

  const runner = (async () => {
    let attempt = 0
    while (running) {
      try {
        const candidate = createUtilityEventsConsumer(url, dependencies)
        await candidate.start()
        if (!running) {
          await candidate.stop()
          break
        }
        consumer = candidate
        resolveStarted(true)
        console.log(`Utilities events consumer started for ${utilityEventBindings.join(', ')}`)
        return
      } catch (error) {
        console.error('[Utilities events] Consumer startup failed; retrying', error)
        attempt += 1
        const waitMs = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))
        await new Promise<void>(resolve => setTimeout(resolve, waitMs))
      }
    }
    resolveStarted(false)
  })()

  return {
    whenStarted,
    async stop() {
      running = false
      if (consumer) await consumer.stop()
      await runner
    }
  }
}
