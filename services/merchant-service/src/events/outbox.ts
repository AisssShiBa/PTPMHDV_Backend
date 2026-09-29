import { randomUUID } from 'node:crypto'
import { MerchantOutboxEvent } from '@prisma/client'
import { prisma } from '../config/prisma'
import { env } from '../config/env'

export async function claimEvent(): Promise<MerchantOutboxEvent | null> {
  const token = randomUUID()
  return prisma.$transaction(async tx => {
    const ids = await tx.$queryRaw<{ id: string }[]>`
      UPDATE merchant_outbox_events SET
        status = 'PROCESSING', attempts = attempts + 1,
        lock_token = ${token}, locked_until = NOW() + INTERVAL '30 seconds'
      WHERE id = (
        SELECT e.id FROM merchant_outbox_events e
        WHERE ((e.status = 'PENDING' AND e.next_attempt_at <= NOW())
           OR (e.status = 'PROCESSING' AND e.locked_until <= NOW()))
        AND NOT EXISTS (
          SELECT 1 FROM merchant_outbox_events earlier
          WHERE earlier.aggregate_id = e.aggregate_id
            AND earlier.aggregate_version < e.aggregate_version
            AND earlier.status <> 'PUBLISHED'
        )
        ORDER BY e.created_at, e.id
        FOR UPDATE OF e SKIP LOCKED LIMIT 1
      ) RETURNING id
    `
    return ids[0] ? tx.merchantOutboxEvent.findUnique({ where: { id: ids[0].id } }) : null
  })
}
export async function publishOne(send: (event: MerchantOutboxEvent) => Promise<void>) {
  const event = await claimEvent()
  if (!event) return false
  const where = { id: event.id, status: 'PROCESSING', lockToken: event.lockToken }
  try {
    await send(event)
    await prisma.merchantOutboxEvent.updateMany({ where, data: {
      status: 'PUBLISHED', publishedAt: new Date(), lockedUntil: null, lockToken: null, lastError: null
    } })
  } catch {
    const status = event.attempts >= env.eventMaxRetries ? 'FAILED' : 'PENDING'
    const delayMs = Math.min(60000, env.eventRetryMs * 2 ** (event.attempts - 1))
    // Scheduling and claiming use the same database clock, even across hosts.
    await prisma.$executeRaw`
      UPDATE merchant_outbox_events
      SET status = ${status}, next_attempt_at = NOW() + ${delayMs} * INTERVAL '1 millisecond',
          locked_until = NULL, lock_token = NULL, last_error = 'PUBLISH_FAILED'
      WHERE id = ${event.id} AND status = 'PROCESSING' AND lock_token = ${event.lockToken}
    `
    console.error(JSON.stringify({ eventId: event.id, code: 'OUTBOX_PUBLISH_FAILED', retryCount: event.attempts }))
  }
  return true
}
export async function replayFailed(id: string) {
  return prisma.merchantOutboxEvent.updateMany({ where: { id, status: 'FAILED' }, data: {
    status: 'PENDING', attempts: 0, nextAttemptAt: new Date(0), lastError: null, lockedUntil: null, lockToken: null
  } })
}
