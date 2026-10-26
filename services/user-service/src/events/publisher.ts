import { createPublisher, FinvaultEvent } from 'finvault-events'
import { setTimeout as delay } from 'node:timers/promises'
import { env } from '../config/env'
import { publishOne } from './outbox'

export async function startOutboxPublisher(signal: AbortSignal) {
  if (!env.rabbitmqUrl) throw new Error('RABBITMQ_URL is required for the publisher')
  const publisher = createPublisher({ url: env.rabbitmqUrl, exchange: env.eventExchange })
  try {
    while (!signal.aborted) {
      let worked = false
      try {
        worked = await publishOne(async event => {
          const payload = event.payload as unknown as FinvaultEvent
          if (payload.eventId !== event.id || payload.eventType !== event.eventType)
            throw new Error('Outbox identity mismatch')
          await publisher.publish(payload)
        })
      } catch {
        console.error(JSON.stringify({ code: 'PUBLISHER_LOOP_ERROR' }))
      }
      if (!worked) await delay(env.outboxPollMs, undefined, { signal }).catch(() => {})
    }
  } finally {
    await publisher.close().catch(() => {})
  }
}
