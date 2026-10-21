import type { FinvaultEvent } from './schemas'

export type InboxResult<T> =
  | { status: 'processed'; result: T }
  | { status: 'duplicate' }
  | { status: 'conflict' }

export interface InboxAdapter {
  runOnce<T>(
    args: { eventId: string; eventType: string; payloadHash: string },
    fn: (tx: unknown) => Promise<T>
  ): Promise<InboxResult<T>>
}

export function createInMemoryInbox(): InboxAdapter {
  const records = new Map<string, string>()
  let lock: Promise<void> = Promise.resolve()

  return {
    async runOnce<T>(
      args: { eventId: string; eventType: string; payloadHash: string },
      fn: (tx: unknown) => Promise<T>
    ): Promise<InboxResult<T>> {
      let release!: () => void
      const previous = lock
      lock = new Promise<void>(resolve => { release = resolve })
      await previous
      try {
        const previousHash = records.get(args.eventId)
        if (previousHash !== undefined) {
          return previousHash === args.payloadHash ? { status: 'duplicate' } : { status: 'conflict' }
        }
        const result = await fn(undefined)
        records.set(args.eventId, args.payloadHash)
        return { status: 'processed', result }
      } finally {
        release()
      }
    }
  }
}

export type EventHandler<T = unknown, R = unknown> = (
  event: FinvaultEvent<T>,
  context: { tx: unknown }
) => Promise<R>
