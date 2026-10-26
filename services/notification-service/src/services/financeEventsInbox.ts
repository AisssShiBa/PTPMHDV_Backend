import type { InboxAdapter, InboxResult } from 'finvault-events'
import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '../config/prisma'

export type FinanceTransactionContext = {
  prisma: Prisma.TransactionClient
  afterCommit(callback: () => void | Promise<void>): void
}

export function createFinanceEventsInbox(database: PrismaClient = prisma): InboxAdapter {
  return {
    async runOnce<T>(
      args: { eventId: string; eventType: string; payloadHash: string },
      handler: (tx: unknown) => Promise<T>
    ): Promise<InboxResult<T>> {
      const afterCommit: Array<() => void | Promise<void>> = []
      const result = await database.$transaction(async (transaction) => {
        const inserted = await transaction.$executeRaw`
          INSERT INTO "NotificationInbox" ("eventId", "source", "payloadHash")
          VALUES (${args.eventId}, 'finvault.events', ${args.payloadHash})
          ON CONFLICT ("eventId") DO NOTHING
        `

        if (inserted === 0) {
          const rows = await transaction.$queryRaw<Array<{ payloadHash: string }>>`
            SELECT "payloadHash"
            FROM "NotificationInbox"
            WHERE "eventId" = ${args.eventId}
          `
          const existing = rows[0]
          if (!existing) throw new Error('Notification inbox row missing after conflict')
          return existing.payloadHash === args.payloadHash
            ? { status: 'duplicate' as const }
            : { status: 'conflict' as const }
        }

        const context: FinanceTransactionContext = {
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
            console.error('[Socket] Finance event after-commit callback failed', {
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
