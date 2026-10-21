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

export function publishConfirmed(
  channel: ConfirmChannel,
  exchange: string,
  routingKey: string,
  content: Buffer,
  options: Options.Publish,
  timeoutMs: number
): Promise<void> {
  const messageId = options.messageId ?? randomUUID()
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let returned = false
    const finish = (error?: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      channel.removeListener('return', onReturn)
      channel.removeListener('close', onClose)
      if (error) reject(error)
      else if (returned) reject(new BrokerPublishError('Broker returned an unroutable event', 'UNROUTABLE_EVENT'))
      else resolve()
    }
    const onReturn = (message: { properties: { messageId?: string } }) => {
      if (message.properties.messageId === messageId) returned = true
    }
    const onClose = () => finish(new BrokerPublishError('Publisher channel closed before confirmation', 'CHANNEL_CLOSED'))
    const timer = setTimeout(() => finish(new BrokerPublishError('Timed out waiting for broker confirmation', 'PUBLISH_TIMEOUT')), timeoutMs)

    channel.on('return', onReturn)
    channel.once('close', onClose)
    try {
      channel.publish(exchange, routingKey, content, { ...options, messageId, mandatory: true }, error => finish(error))
    } catch (error) {
      finish(error instanceof Error ? error : new BrokerPublishError('Publish failed', 'PUBLISH_FAILED'))
    }
  })
}
