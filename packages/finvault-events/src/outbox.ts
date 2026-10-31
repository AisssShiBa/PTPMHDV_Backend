import { parseFinvaultEvent, type FinvaultEvent } from './schemas'

export interface OutboxEventMetadata {
  id: string
  createdAt: Date | string
}

export function createEventFromOutbox<T>(
  outbox: OutboxEventMetadata,
  eventType: string,
  data: T,
  eventVersion = 1
): FinvaultEvent<T> {
  const createdAt = outbox.createdAt instanceof Date
    ? outbox.createdAt
    : new Date(outbox.createdAt)
  if (!Number.isFinite(createdAt.getTime())) {
    throw new TypeError('Outbox createdAt must be a valid date')
  }

  const event = parseFinvaultEvent({
    eventId: outbox.id,
    eventType,
    eventVersion,
    occurredAt: createdAt.toISOString(),
    data
  })
  return { ...event, data: event.data as T }
}

export function createSingleFlight<T>(task: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | undefined
  return () => {
    if (inFlight) return inFlight
    let wrapped: Promise<T>
    const current = Promise.resolve().then(task)
    wrapped = current.finally(() => {
      if (inFlight === wrapped) inFlight = undefined
    })
    inFlight = wrapped
    return wrapped
  }
}
