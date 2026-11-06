import type { InboxAdapter, InboxResult } from 'finvault-events'
import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '../config/prisma'

export type UtilityTransactionContext = {
  prisma: Prisma.TransactionClient
  afterCommit(callback: () => void | Promise<void>): void
}

export function createUtilityInbox(database: PrismaClient = prisma): InboxAdapter {
  return {
    async runOnce<T>(
      args: { eventId: string; eventType: string; payloadHash: string },
      handler: (tx: unknown) => Promise<T>
    ): Promise<InboxResult<T>> {
      const afterCommit: Array<() => void | Promise<void>> = []
      const result = await database.$transaction(async transaction => {
        const inserted = await transaction.$executeRaw`
          INSERT INTO "utility_inbox" ("event_id", "event_type", "payload_hash")
          VALUES (${args.eventId}, ${args.eventType}, ${args.payloadHash})
          ON CONFLICT ("event_id") DO NOTHING
        `

        if (inserted === 0) {
          const rows = await transaction.$queryRaw<Array<{ payload_hash: string }>>`
            SELECT "payload_hash"
            FROM "utility_inbox"
            WHERE "event_id" = ${args.eventId}
          `
          const existing = rows[0]
          if (!existing) throw new Error('Utility inbox row missing after conflict')
          return existing.payload_hash === args.payloadHash
            ? { status: 'duplicate' as const }
            : { status: 'conflict' as const }
        }

        const context: UtilityTransactionContext = {
          prisma: transaction,
          afterCommit: callback => afterCommit.push(callback)
        }
        return { status: 'processed' as const, result: await handler(context) }
      })

      if (result.status === 'processed') {
        for (const callback of afterCommit) {
          try {
            await callback()
          } catch (error) {
            console.error('[Utilities] after-commit callback failed', {
              eventId: args.eventId,
              error
            })
          }
        }
      }

      return result
    }
  }
}
