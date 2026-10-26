import { createConsumer, type EventConsumer, type FinvaultEvent } from 'finvault-events'
import type { Notification } from '@prisma/client'
import { env } from '../config/env'
import { prisma } from '../config/prisma'
import { notificationIO } from '../socket'
import { createFinanceEventsInbox, type FinanceTransactionContext } from './financeEventsInbox'
import {
  mapFinanceEventToNotifications,
  paymentCounterpartyIds,
  type FinanceNotificationDraft
} from './financeEventMapping'
import { createUserLookupClient } from './userLookup'

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
const userLookup = createUserLookupClient({
  baseUrl: env.userLookupUrl,
  internalKey: env.internalKey,
  timeoutMs: 1500,
  cacheTtlMs: 60_000,
  maxCacheEntries: 1000,
  logFailure: (code, userId) => {
    console.warn('[User lookup] Enrichment unavailable', { code, userId })
  }
})

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
  const created: Array<{ draft: FinanceNotificationDraft; notification: Notification }> = []

  for (const draft of drafts) {
    const notification = await transaction.prisma.notification.create({
      data: {
        eventId: event.eventId,
        userId: draft.userId,
        type: draft.type,
        message: draft.message
      }
    })
    created.push({ draft, notification })
  }

  transaction.afterCommit(async () => {
    let notifications = created.map(item => item.notification)
    if (event.eventType === 'payment.succeeded') {
      const ids = [...new Set(paymentCounterpartyIds(event))]
      const fullNames = await Promise.all(ids.map(id => userLookup.getFullName(id)))
      const names = new Map<string, string>()
      fullNames.forEach((fullName, index) => {
        if (fullName) names.set(ids[index], fullName)
      })
      const enriched = mapFinanceEventToNotifications(event, names)
      notifications = await Promise.all(created.map(async item => {
        const replacement = enriched.find(draft => draft.userId === item.draft.userId)
        if (!replacement || replacement.message === item.notification.message) return item.notification
        try {
          return await prisma.notification.update({
            where: { id: item.notification.id },
            data: { message: replacement.message }
          })
        } catch (error) {
          console.error('[Notification] Could not persist enriched payment message', {
            eventId: event.eventId,
            userId: item.draft.userId,
            error
          })
          return item.notification
        }
      }))
    }

    for (const notification of notifications) {
      try {
        notificationIO?.to(`user:${notification.userId}`).emit('notification:new', notification)
      } catch (error) {
        console.error('[Socket] Could not emit finance notification', {
          eventId: event.eventId,
          userId: notification.userId,
          error
        })
      }
    }
  })
}

export async function startFinanceEventsConsumer(): Promise<void> {
  if (!env.rabbitmqUrl) {
    console.log('FinVault events consumer disabled: RABBITMQ_URL is not configured')
    return
  }

  console.info(
    '[FinVault events] Ignoring user.registered and merchant.status_updated: no notification recipient is defined'
  )
  if (!env.userLookupUrl) {
    console.info('[User lookup] USER_LOOKUP_URL is unset; payment notifications will use anonymous wording')
  }
  const consumer = createFinanceEventsConsumer(env.rabbitmqUrl)
  await consumer.start()
  console.log(`FinVault events consumer started for ${financeEventBindings.join(', ')}`)
}
