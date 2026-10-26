import { createConsumer, type EventConsumer, type FinvaultEvent } from 'finvault-events'
import { env } from '../config/env'
import { prisma } from '../config/prisma'
import { notificationIO } from '../socket'
import { createFinanceEventsInbox, type FinanceTransactionContext } from './financeEventsInbox'
import { mapFinanceEventToNotifications } from './financeEventMapping'

export const financeEventQueue = 'notification.finvault.events'
export const financeEventBindings = [
  'user.registered',
  'user.kyc_updated',
  'merchant.status_updated',
  'payment.succeeded',
  'payment.failed',
  'payment.expired'
] as const

const ignoredEventTypes = ['user.registered', 'merchant.status_updated']

export function createFinanceEventsConsumer(
  url: string,
  queue = financeEventQueue
): EventConsumer {
  return createConsumer({
    url,
    queue,
    exchange: 'finvault.events',
    bindings: [...financeEventBindings],
    ignoredEventTypes,
    allowLegacyKycUpdated: true,
    logger: {
      info: (message, context) => console.info(`[FinVault events] ${message}`, context)
    },
    inbox: createFinanceEventsInbox(prisma),
    handlers: {
      'user.kyc_updated': (event, context) => persistEventNotifications(event, context),
      'payment.succeeded': (event, context) => persistEventNotifications(event, context),
      'payment.failed': (event, context) => persistEventNotifications(event, context),
      'payment.expired': (event, context) => persistEventNotifications(event, context)
    }
  })
}

async function persistEventNotifications(event: FinvaultEvent, context: { tx: unknown }): Promise<void> {
  const transaction = context.tx as FinanceTransactionContext
  const drafts = mapFinanceEventToNotifications(event)

  for (const draft of drafts) {
    const notification = await transaction.prisma.notification.create({
      data: {
        eventId: event.eventId,
        userId: draft.userId,
        type: draft.type,
        message: draft.message
      }
    })
    transaction.afterCommit(() => {
      try {
        notificationIO?.to(`user:${draft.userId}`).emit('notification:new', notification)
      } catch (error) {
        console.error('[Socket] Could not emit finance notification', {
          eventId: event.eventId,
          userId: draft.userId,
          error
        })
      }
    })
  }
}

export async function startFinanceEventsConsumer(): Promise<void> {
  if (!env.rabbitmqUrl) {
    console.log('FinVault events consumer disabled: RABBITMQ_URL is not configured')
    return
  }

  console.info(
    '[FinVault events] Ignoring user.registered and merchant.status_updated: no notification recipient is defined'
  )
  const consumer = createFinanceEventsConsumer(env.rabbitmqUrl)
  await consumer.start()
  console.log(`FinVault events consumer started for ${financeEventBindings.join(', ')}`)
}
