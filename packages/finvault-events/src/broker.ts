import type { ConfirmChannel, Options } from 'amqplib'
import { randomUUID } from 'node:crypto'

export interface EventLogger {
  info?(message: string, context: { eventId?: string; eventType?: string }): void
  error?(message: string, context: { eventId?: string; eventType?: string }): void
}

export class BrokerPublishError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = 'BrokerPublishError'
  }
}

interface PendingConfirmation {
  messageId: string
  finish: (error?: Error | null) => void
  markReturned: () => void
}

interface ConfirmationState {
  pending: Set<PendingConfirmation>
}

const confirmationStates = new WeakMap<ConfirmChannel, ConfirmationState>()

function getConfirmationState(channel: ConfirmChannel): ConfirmationState {
  const existing = confirmationStates.get(channel)
  if (existing) return existing

  const state: ConfirmationState = { pending: new Set() }
  confirmationStates.set(channel, state)
  channel.on('return', message => {
    const messageId = message.properties.messageId
    for (const pending of state.pending) {
      if (pending.messageId === messageId) pending.markReturned()
    }
  })
  channel.on('close', () => {
    for (const pending of [...state.pending]) {
      pending.finish(new BrokerPublishError('Publisher channel closed before confirmation', 'CHANNEL_CLOSED'))
    }
  })
  return state
}

export function publishConfirmed(
  channel: ConfirmChannel,
  exchange: string,
  routingKey: string,
  content: Buffer,
  options: Options.Publish,
  timeoutMs: number
): Promise<void> {
  const messageId = options.messageId ?? randomUUID()
  const state = getConfirmationState(channel)
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let returned = false
    const finish = (error?: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      state.pending.delete(pending)
      if (error) reject(error)
      else if (returned) reject(new BrokerPublishError('Broker returned an unroutable event', 'UNROUTABLE_EVENT'))
      else resolve()
    }
    const pending: PendingConfirmation = {
      messageId,
      finish,
      markReturned: () => { returned = true }
    }
    const timer = setTimeout(() => finish(new BrokerPublishError('Timed out waiting for broker confirmation', 'PUBLISH_TIMEOUT')), timeoutMs)

    state.pending.add(pending)
    try {
      channel.publish(exchange, routingKey, content, { ...options, messageId, mandatory: true }, error => finish(error))
    } catch (error) {
      finish(error instanceof Error ? error : new BrokerPublishError('Publish failed', 'PUBLISH_FAILED'))
    }
  })
}
