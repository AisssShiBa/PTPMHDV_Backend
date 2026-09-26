import { prisma } from '../config/prisma'
import { env } from '../config/env'
import { runWorker, pause, publishConfirmed } from './amqp'
import { publishOne } from './outbox'
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())
runWorker(async (channel, signal) => {
  while (!signal.aborted) {
    const worked = await publishOne(event => publishConfirmed(channel, env.eventExchange, event.eventType,
      Buffer.from(JSON.stringify(event.payload)), { contentType: 'application/json', messageId: event.id }))
    if (!worked) await pause(env.outboxPollMs, signal)
  }
}, controller.signal).catch(() => {
  console.error(JSON.stringify({ code: 'PUBLISHER_STOPPED' }))
  process.exitCode = 1
}).finally(() => prisma.$disconnect())
