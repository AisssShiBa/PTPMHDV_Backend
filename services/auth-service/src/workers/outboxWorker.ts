import { randomUUID } from 'node:crypto'
import { createPublisher, type EventPublisher } from 'finvault-events'
import { AuthOutboxEvent } from '@prisma/client'
import { prisma } from '../config/prisma'

let timer: NodeJS.Timeout | undefined
let active: Promise<number> | undefined
let publisher: EventPublisher | undefined
async function processBatch(): Promise<number> {
  publisher ??= createPublisher({ url: process.env.RABBITMQ_URL!, exchange: process.env.EVENT_EXCHANGE || 'finvault.events' })
  let count = 0
  for (let i = 0; i < 20; i++) {
    const token = randomUUID()
    const rows = await prisma.$queryRaw<AuthOutboxEvent[]>`
      UPDATE "AuthOutboxEvent" SET "lockToken"=${token}, "lockedUntil"=NOW()+INTERVAL '30 seconds', attempts=attempts+1
      WHERE id=(SELECT id FROM "AuthOutboxEvent" WHERE status='PENDING' AND "nextAttemptAt"<=NOW()
        AND ("lockedUntil" IS NULL OR "lockedUntil"<=NOW()) ORDER BY "createdAt"
        FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`
    const event = rows[0]
    if (!event) break
    try {
      await publisher.publish({ eventId: event.id, eventType: event.eventType, eventVersion: 1,
        occurredAt: event.createdAt.toISOString(), data: event.payload })
      await prisma.authOutboxEvent.updateMany({ where: { id: event.id, lockToken: token },
        data: { status: 'PUBLISHED', publishedAt: new Date(), lockedUntil: null, lockToken: null } })
      count++
    } catch {
      // Broker outages remain recoverable across restarts; never discard provisioning.
      await prisma.authOutboxEvent.updateMany({ where: { id: event.id, lockToken: token }, data: {
        lockedUntil: null, lockToken: null,
        nextAttemptAt: new Date(Date.now() + Math.min(30000, 1000 * 2 ** Math.min(event.attempts, 5)))
      } })
      break
    }
  }
  return count
}
export const OutboxWorker = {
  processBatch(): Promise<number> {
    if (active) return active
    active = processBatch().finally(() => { active = undefined })
    return active
  },
  start(intervalMs = 500) {
    if (timer) return
    if (!process.env.RABBITMQ_URL) throw new Error('RABBITMQ_URL is required for Auth provisioning')
    const tick = () => { void this.processBatch().catch(() => console.error('[Auth Outbox] Retry pending batch')) }
    timer = setInterval(tick, intervalMs)
    tick()
  },
  async stop() {
    clearInterval(timer)
    timer = undefined
    await active?.catch(() => {})
    await publisher?.close()
    publisher = undefined
  }
}
