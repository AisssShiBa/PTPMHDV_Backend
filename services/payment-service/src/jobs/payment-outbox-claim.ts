import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'

export const PAYMENT_OUTBOX_BATCH_SIZE = 10
export const PAYMENT_OUTBOX_LEASE_MS = 120_000

export async function claimPaymentOutboxEvents(
  prisma: PrismaClient,
  now = new Date(),
  aggregateIdPrefix?: string
): Promise<Array<{ id: string; lockToken: string }>> {
  const lockToken = randomUUID()
  const lockedUntil = new Date(now.getTime() + PAYMENT_OUTBOX_LEASE_MS)
  return prisma.$transaction(async tx => {
    return tx.$queryRaw<Array<{ id: string; lockToken: string }>>`
      WITH candidates AS (
        SELECT "id"
        FROM "OutboxEvent"
        WHERE (
          ("status" = 'PENDING' AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= ${now}))
          OR ("status" = 'PROCESSING' AND "lockedUntil" <= ${now})
        )
          AND (${aggregateIdPrefix ?? null}::text IS NULL OR "aggregateId" LIKE ${aggregateIdPrefix ? `${aggregateIdPrefix}%` : ''})
        ORDER BY "createdAt" ASC
        LIMIT ${PAYMENT_OUTBOX_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "OutboxEvent" AS outbox
      SET "status" = 'PROCESSING',
          "lockedUntil" = ${lockedUntil},
          "lockToken" = ${lockToken}::uuid
      FROM candidates
      WHERE outbox."id" = candidates."id"
      RETURNING outbox."id", outbox."lockToken"
    `
  }, { maxWait: 5000, timeout: 10_000 })
}
