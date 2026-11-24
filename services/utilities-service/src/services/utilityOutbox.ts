import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Prisma, type UtilityOrderStatus, type UtilityOutbox } from '@prisma/client'
import { createEventFromOutbox, createPublisher, parseFinvaultEvent, type FinvaultEvent } from 'finvault-events'
import { prisma } from '../config/prisma'

const eventTypeFor = (status: UtilityOrderStatus): string | undefined => {
  if (status === 'SUCCESS') return 'utility.order_succeeded'
  if (status === 'FAILED' || status === 'REFUND_FAILED') return 'utility.order_failed'
  if (status === 'REFUNDED') return 'utility.order_refunded'
  return undefined
}

export async function enqueueUtilityOutcome(tx: Prisma.TransactionClient, orderId: string, status: UtilityOrderStatus) {
  const eventType = eventTypeFor(status)
  if (!eventType) return
  const order = await tx.utilityOrder.findUniqueOrThrow({ where: { id: orderId } })
  if (order.status !== status) throw new Error('Utility event does not match order state')
  if (!order.amount.isInteger() || order.amount.isNegative()) throw new Error('Invalid utility event amount')
  const metadata = { id: randomUUID(), createdAt: new Date() }
  const event = createEventFromOutbox(metadata, eventType, {
    orderId, userId: order.userId, amount: order.amount.toFixed(0), utilityType: order.type,
    paymentId: order.paymentId,
    ...(order.failureReason ? { reason: order.failureReason } : {})
  })
  // The state CAS and this insert share the caller's transaction.
  await tx.utilityOutbox.createMany({ skipDuplicates: true, data: {
    id: metadata.id, orderId, eventType, createdAt: metadata.createdAt,
    payload: event as unknown as Prisma.InputJsonValue
  } })
}

export async function publishUtilityOutboxBatch(publish: (event: FinvaultEvent) => Promise<void>, limit = 20) {
  const token = randomUUID()
  const rows = await prisma.$queryRaw<UtilityOutbox[]>`
    UPDATE "utility_outbox" SET "lock_token" = ${token}::uuid,
      "locked_until" = NOW() + INTERVAL '30 seconds', "attempts" = "attempts" + 1
    WHERE id IN (SELECT id FROM "utility_outbox"
      WHERE "published_at" IS NULL AND ("locked_until" IS NULL OR "locked_until" <= NOW())
      ORDER BY "created_at", id FOR UPDATE SKIP LOCKED LIMIT ${limit})
    RETURNING id, order_id AS "orderId", event_type AS "eventType", payload,
      created_at AS "createdAt", published_at AS "publishedAt", locked_until AS "lockedUntil",
      lock_token AS "lockToken", attempts
  `
  let published = 0
  for (const row of rows) {
    try {
      const event = parseFinvaultEvent(row.payload)
      const data = event.data as { orderId?: string }
      if (event.eventId !== row.id || event.eventType !== row.eventType || data.orderId !== row.orderId) {
        throw new Error('Utility outbox identity mismatch')
      }
      await publish(event)
      const updated = await prisma.utilityOutbox.updateMany({
        where: { id: row.id, lockToken: token, publishedAt: null },
        data: { publishedAt: new Date(), lockedUntil: null, lockToken: null }
      })
      published += updated.count
    } catch {
      // Delivery may already have succeeded: keep the same eventId on retry.
      await prisma.utilityOutbox.updateMany({
        where: { id: row.id, lockToken: token, publishedAt: null },
        data: { lockedUntil: new Date(Date.now() + 2000), lockToken: null }
      })
      console.error(JSON.stringify({ code: 'UTILITY_EVENT_PUBLISH_FAILED', eventId: row.id }))
    }
  }
  return { claimed: rows.length, published }
}

export async function startUtilityOutboxPublisher(url: string, signal: AbortSignal) {
  const publisher = createPublisher({ url, exchange: 'finvault.events' })
  try {
    while (!signal.aborted) {
      try { await publishUtilityOutboxBatch(event => publisher.publish(event)) }
      catch { console.error(JSON.stringify({ code: 'UTILITY_OUTBOX_RETRY' })) }
      await delay(500, undefined, { signal }).catch(() => {})
    }
  } finally { await publisher.close().catch(() => {}) }
}
