import amqp, { type ChannelModel, type ConfirmChannel, type Options } from 'amqplib'
import { setTimeout as delay } from 'node:timers/promises'
import type { EventLogger } from './broker'
import { BrokerPublishError, publishConfirmed } from './broker'
import { parseFinvaultEvent, type FinvaultEvent } from './schemas'

export interface PublisherOptions {
  url: string
  exchange?: string
  confirmTimeoutMs?: number
  logger?: EventLogger
}

export interface EventPublisher {
  publish(event: FinvaultEvent): Promise<void>
  close(): Promise<void>
}

export function createPublisher(options: PublisherOptions): EventPublisher {
  const exchange = options.exchange ?? 'finvault.events'
  const timeoutMs = options.confirmTimeoutMs ?? 10000
  if (!options.url || !Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('Publisher requires a broker URL and positive confirmation timeout')
  }
  let connection: ChannelModel | undefined
  let channel: ConfirmChannel | undefined
  let connecting: Promise<ConfirmChannel> | undefined
  let closed = false
  const pending = new Set<(error: Error) => void>()

  const discardConnection = (error: Error, sourceConnection: ChannelModel, sourceChannel?: ConfirmChannel) => {
    if (sourceChannel) {
      if (connection !== sourceConnection || channel !== sourceChannel) return
    } else if (connection !== sourceConnection) {
      return
    }
    for (const reject of pending) reject(error)
    pending.clear()
    channel = undefined
    connection = undefined
    connecting = undefined
  }

  async function getChannel(): Promise<ConfirmChannel> {
    if (closed) throw new Error('Publisher is closed')
    if (channel) return channel
    if (connecting) return connecting
    connecting = (async () => {
      let lastError: unknown
      for (const waitMs of [0, 250, 1000]) {
        if (waitMs > 0) await delay(waitMs)
        let nextConnection: ChannelModel | undefined
        let nextChannel: ConfirmChannel | undefined
        try {
          if (closed) throw new Error('Publisher is closed')
          const establishedConnection = await amqp.connect(options.url)
          nextConnection = establishedConnection
          establishedConnection.on('error', () => undefined)
          establishedConnection.once('close', () => discardConnection(
            new BrokerPublishError('Broker connection closed', 'CONNECTION_CLOSED'),
            establishedConnection
          ))
          const establishedChannel = await establishedConnection.createConfirmChannel()
          nextChannel = establishedChannel
          establishedChannel.on('error', () => undefined)
          establishedChannel.once('close', () => discardConnection(
            new BrokerPublishError('Publisher channel closed', 'CHANNEL_CLOSED'),
            establishedConnection,
            establishedChannel
          ))
          await establishedChannel.assertExchange(exchange, 'topic', { durable: true })
          if (closed) throw new Error('Publisher is closed')
          connection = establishedConnection
          channel = establishedChannel
          return establishedChannel
        } catch (error) {
          lastError = error
          if (connection === nextConnection) connection = undefined
          if (channel === nextChannel) channel = undefined
          await nextChannel?.close().catch(() => {})
          await nextConnection?.close().catch(() => {})
        }
      }
      throw lastError
    })().finally(() => {
      connecting = undefined
    })
    return connecting
  }

  return {
    async publish(value) {
      const event = parseFinvaultEvent(value)
      const body = Buffer.from(JSON.stringify(event))
      const activeChannel = await getChannel()
      if (activeChannel !== channel || !connection) {
        throw new BrokerPublishError('Broker connection changed before publish', 'CONNECTION_CLOSED')
      }
      options.logger?.info?.('Publishing FinVault event', { eventId: event.eventId, eventType: event.eventType })
      let rejectPending!: (error: Error) => void
      const disconnected = new Promise<never>((_, reject) => { rejectPending = reject })
      pending.add(rejectPending)
      try {
        await Promise.race([
          publishConfirmed(activeChannel, exchange, event.eventType, body, {
            persistent: true,
            contentType: 'application/json',
            type: event.eventType,
            messageId: event.eventId,
            headers: { 'x-event-version': event.eventVersion }
          } satisfies Options.Publish, timeoutMs),
          disconnected
        ])
      } catch (error) {
        options.logger?.error?.('FinVault event publish failed', { eventId: event.eventId, eventType: event.eventType })
        throw error
      } finally {
        pending.delete(rejectPending)
      }
    },
    async close() {
      closed = true
      const error = new BrokerPublishError('Publisher closed', 'PUBLISHER_CLOSED')
      for (const reject of pending) reject(error)
      pending.clear()
      const activeChannel = channel
      const activeConnection = connection
      channel = undefined
      connection = undefined
      await activeChannel?.close().catch(() => {})
      await activeConnection?.close().catch(() => {})
    }
  }
}
