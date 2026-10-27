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
import { createUserLookupClient, type UserLookupClient } from './userLookup'

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
const retryInitialDelayMs = 2000
const retryMaxDelayMs = 30_000

export interface FinanceConsumerSupervisor {
  whenStarted: Promise<boolean>
  stop(): Promise<void>
}

interface FinanceConsumerRetryOptions {
  url: string
  createConsumer(url: string): EventConsumer
  initialDelayMs?: number
  maxDelayMs?: number
  sleep?(milliseconds: number, signal: AbortSignal): Promise<void>
  logError?(message: string, error: unknown): void
  logStarted?(): void
}

const abortableDelay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

export function startFinanceEventsConsumerWithRetry(
  options: FinanceConsumerRetryOptions
): FinanceConsumerSupervisor {
  const initialDelayMs = options.initialDelayMs ?? retryInitialDelayMs
  const maxDelayMs = options.maxDelayMs ?? retryMaxDelayMs
  if (!Number.isInteger(initialDelayMs) || initialDelayMs < 1 ||
      !Number.isInteger(maxDelayMs) || maxDelayMs < initialDelayMs) {
    throw new TypeError('Consumer retry delays must be positive integers with max >= initial')
  }

  const controller = new AbortController()
  let running = true
  let activeConsumer: EventConsumer | undefined
  let retryCount = 0
  let resolveStarted!: (started: boolean) => void
  const whenStarted = new Promise<boolean>(resolve => { resolveStarted = resolve })

  const runner = (async () => {
    while (running) {
      let candidate: EventConsumer | undefined
      try {
        candidate = options.createConsumer(options.url)
        await candidate.start()
        if (!running) {
          await candidate.stop()
          break
        }
        activeConsumer = candidate
        options.logStarted?.()
        resolveStarted(true)
        return
      } catch (error) {
        options.logError?.('Consumer startup failed; retrying', error)
        if (candidate) {
          try {
            await candidate.stop()
          } catch (stopError) {
            options.logError?.('Failed to close consumer after startup error', stopError)
          }
        }
        if (!running) break
        const waitMs = Math.min(maxDelayMs, initialDelayMs * 2 ** Math.min(retryCount, 30))
        retryCount += 1
        try {
          await (options.sleep ?? abortableDelay)(waitMs, controller.signal)
        } catch (sleepError) {
          if (running) options.logError?.('Consumer retry wait failed', sleepError)
        }
      }
    }
    resolveStarted(false)
  })()

  return {
    whenStarted,
    async stop() {
      running = false
      controller.abort()
      const consumer = activeConsumer
      activeConsumer = undefined
      if (consumer) await consumer.stop()
      await runner
    }
  }
}
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

export interface FinanceEventsConsumerDependencies {
  userLookup?: UserLookupClient
  updateNotification?(
    id: string,
    message: string
  ): Promise<Notification>
}

export function createFinanceEventsConsumer(
  url: string,
  queue = financeEventQueue,
  dependencies: FinanceEventsConsumerDependencies = {}
): EventConsumer {
  const lookup = dependencies.userLookup ?? userLookup
  const updateNotification = dependencies.updateNotification ?? ((id: string, message: string) =>
    prisma.notification.update({ where: { id }, data: { message } }))
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
      'user.kyc_updated': (event, context) =>
        persistEventNotifications(event, context, lookup, updateNotification),
      'payment.succeeded': (event, context) =>
        persistEventNotifications(event, context, lookup, updateNotification),
      'payment.failed': (event, context) =>
        persistEventNotifications(event, context, lookup, updateNotification),
      'payment.expired': (event, context) =>
        persistEventNotifications(event, context, lookup, updateNotification)
    }
  })
}

async function persistEventNotifications(
  event: FinvaultEvent,
  context: { tx: unknown },
  userLookup: UserLookupClient,
  updateNotification: (id: string, message: string) => Promise<Notification>
): Promise<void> {
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
          return await updateNotification(item.notification.id, replacement.message)
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

export function startFinanceEventsConsumer(): FinanceConsumerSupervisor | undefined {
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
  return startFinanceEventsConsumerWithRetry({
    url: env.rabbitmqUrl,
    createConsumer: url => createFinanceEventsConsumer(url),
    logError: (message, error) => console.error(`[FinVault events] ${message}`, error),
    logStarted: () => console.log(`FinVault events consumer started for ${financeEventBindings.join(', ')}`)
  })
}
