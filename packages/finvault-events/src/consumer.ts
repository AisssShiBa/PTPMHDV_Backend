import amqp, { type Channel, type ChannelModel, type ConfirmChannel, type ConsumeMessage, type Options } from 'amqplib'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { BrokerPublishError, type EventLogger, publishConfirmed } from './broker'
import { type EventHandler, type InboxAdapter } from './inbox'
import { eventPayloadHash, EventValidationError, parseFinvaultEvent, type FinvaultEvent } from './schemas'

export class NonRetryableError extends Error {
  public readonly code: string

  constructor(message: string, code = 'NON_RETRYABLE') {
    super(message)
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
      throw new TypeError('NonRetryableError code must be a short uppercase identifier')
    }
    this.code = code
    this.name = 'NonRetryableError'
  }
}

export interface ConsumerOptions {
  url: string
  queue: string
  bindings: string[]
  exchange?: string
  prefetch?: number
  maxRetries?: number
  retryDelaysMs?: number[]
  confirmTimeoutMs?: number
  reconnectDelayMs?: number
  allowLegacyKycUpdated?: boolean
  inbox: InboxAdapter
  handlers: Record<string, EventHandler>
  logger?: EventLogger
}

export interface EventConsumer {
  start(): Promise<void>
  stop(): Promise<void>
}

export async function assertConsumerTopology(
  channel: Channel,
  options: Pick<ConsumerOptions, 'queue' | 'bindings' | 'exchange'>
): Promise<void> {
  const exchange = options.exchange ?? 'finvault.events'
  await channel.assertExchange(exchange, 'topic', { durable: true })
  await channel.assertQueue(options.queue, { durable: true })
  for (const binding of options.bindings) {
    await channel.bindQueue(options.queue, exchange, binding)
  }
  await channel.assertQueue(`${options.queue}.retry`, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': options.queue
    }
  })
  await channel.assertQueue(`${options.queue}.dlq`, { durable: true })
}

function retryCount(message: ConsumeMessage): number {
  const value = message.properties.headers?.['x-retry-count']
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value)
  return 0
}

function eventTypeHint(message: ConsumeMessage): string {
  return message.properties.type ?? message.fields.routingKey
}

function safeHeaderString(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 200) : ''
}

function forwardedHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown> {
  const allowed = new Set([
    'x-event-version',
    'x-retry-count',
    'x-original-routing-key',
    'x-death'
  ])
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([key]) => allowed.has(key)))
}

function logError(logger: EventLogger | undefined, message: string, context: { eventId?: string; eventType?: string }): void {
  if (logger?.error) logger.error(message, context)
  else console.error('[finvault-events]', message, context)
}

async function publishToQueue(
  channel: ConfirmChannel,
  queue: string,
  message: ConsumeMessage,
  headers: Record<string, unknown>,
  timeoutMs: number,
  expiration?: string
): Promise<void> {
  await publishConfirmed(channel, '', queue, message.content, {
    persistent: true,
    contentType: message.properties.contentType ?? 'application/json',
    type: message.properties.type,
    messageId: message.properties.messageId ?? randomUUID(),
    correlationId: message.properties.correlationId,
    headers: { ...forwardedHeaders(message.properties.headers), ...headers },
    expiration
  } satisfies Options.Publish, timeoutMs)
}

async function deadLetter(
  channel: ConfirmChannel,
  options: ConsumerOptions,
  message: ConsumeMessage,
  reason: string,
  count: number,
  timeoutMs: number
): Promise<void> {
  await publishToQueue(channel, `${options.queue}.dlq`, message, {
    'x-dlq-reason': reason,
    'x-original-routing-key': safeHeaderString(message.properties.headers?.['x-original-routing-key']) ||
      message.fields.routingKey,
    'x-retry-count': count,
    'x-failed-at': new Date().toISOString()
  }, timeoutMs)
  channel.ack(message)
}

export async function processConsumerMessage(
  channel: ConfirmChannel,
  message: ConsumeMessage,
  options: ConsumerOptions
): Promise<void> {
  const maxRetries = options.maxRetries ?? 3
  const retryDelaysMs = options.retryDelaysMs ?? [1000, 5000, 30000]
  const confirmTimeoutMs = options.confirmTimeoutMs ?? 10000
  const count = retryCount(message)
  let event: FinvaultEvent
  try {
    const value: unknown = JSON.parse(message.content.toString('utf8'))
    event = parseFinvaultEvent(value, { allowLegacyKycUpdated: options.allowLegacyKycUpdated })
    const originalRoutingKey = safeHeaderString(message.properties.headers?.['x-original-routing-key']) ||
      message.fields.routingKey
    if (event.eventType !== originalRoutingKey || (count === 0 && event.eventType !== message.fields.routingKey)) {
      throw new EventValidationError('Routing key must match eventType', 'INVALID_ENVELOPE')
    }
  } catch (error) {
    const reason = error instanceof EventValidationError ? error.reason : 'INVALID_JSON'
    await deadLetter(channel, options, message, reason, count, confirmTimeoutMs)
    return
  }

  const handler = options.handlers[event.eventType]
  if (!handler) {
    await deadLetter(channel, options, message, 'NO_HANDLER', count, confirmTimeoutMs)
    return
  }

  try {
    const result = await options.inbox.runOnce(
      { eventId: event.eventId, eventType: event.eventType, payloadHash: eventPayloadHash(event) },
      tx => handler(event, { tx })
    )
    if (result.status === 'duplicate') {
      channel.ack(message)
      return
    }
    if (result.status === 'conflict') {
      await deadLetter(channel, options, message, 'EVENT_CONFLICT', count, confirmTimeoutMs)
      return
    }
    channel.ack(message)
  } catch (error) {
    const reason = error instanceof NonRetryableError ? error.code : undefined
    if (reason) {
      await deadLetter(channel, options, message, reason, count, confirmTimeoutMs)
      return
    }
    if (count >= maxRetries || retryDelaysMs.length === 0) {
      await deadLetter(channel, options, message, 'MAX_RETRIES_EXCEEDED', count, confirmTimeoutMs)
      return
    }
    const delayMs = retryDelaysMs[Math.min(count, retryDelaysMs.length - 1)]
    try {
      await publishToQueue(channel, `${options.queue}.retry`, message, {
        'x-retry-count': count + 1,
        'x-original-routing-key': safeHeaderString(message.properties.headers?.['x-original-routing-key']) ||
          message.fields.routingKey
      }, confirmTimeoutMs, String(delayMs))
      channel.ack(message)
    } catch (publishError) {
      logError(options.logger, publishError instanceof BrokerPublishError ? publishError.code : 'RETRY_PUBLISH_FAILED', {
        eventId: event.eventId,
        eventType: event.eventType
      })
      channel.nack(message, false, true)
    }
  }
}

function validateConsumerOptions(options: ConsumerOptions): void {
  if (!options.url || !options.queue || options.bindings.length === 0) {
    throw new TypeError('Consumer requires a broker URL, queue name, and at least one binding')
  }
  if (options.prefetch !== undefined && (!Number.isInteger(options.prefetch) || options.prefetch < 1)) {
    throw new TypeError('Consumer prefetch must be a positive integer')
  }
  if (options.maxRetries !== undefined && (!Number.isInteger(options.maxRetries) || options.maxRetries < 0)) {
    throw new TypeError('Consumer maxRetries must be a non-negative integer')
  }
  if (options.retryDelaysMs?.some(value => !Number.isInteger(value) || value < 1)) {
    throw new TypeError('Retry delays must be positive integer milliseconds')
  }
  if (options.reconnectDelayMs !== undefined &&
      (!Number.isInteger(options.reconnectDelayMs) || options.reconnectDelayMs < 1)) {
    throw new TypeError('Consumer reconnect delay must be a positive integer')
  }
}

export function createConsumer(options: ConsumerOptions): EventConsumer {
  validateConsumerOptions(options)
  const reconnectDelayMs = options.reconnectDelayMs ?? 2000
  let running = false
  let activeConnection: ChannelModel | undefined
  let activeChannel: ConfirmChannel | undefined
  let consumerTag: string | undefined
  let signalDisconnect: (() => void) | undefined
  let disconnected: Promise<void> | undefined
  let supervisor: Promise<void> | undefined
  let reconnectController: AbortController | undefined
  const inFlight = new Set<Promise<void>>()

  const settleInFlight = async () => {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight])
  }

  async function connectOnce(): Promise<void> {
    const connection = await amqp.connect(options.url)
    connection.on('error', () => undefined)
    let channel: ConfirmChannel | undefined
    try {
      const active = await connection.createConfirmChannel()
      channel = active
      active.on('error', () => undefined)
      await assertConsumerTopology(active, options)
      await active.prefetch(options.prefetch ?? 10)
      activeConnection = connection
      activeChannel = active

      disconnected = new Promise<void>(resolve => { signalDisconnect = resolve })
      const onClose = () => signalDisconnect?.()
      connection.once('close', onClose)
      active.once('close', onClose)
      connection.once('error', onClose)
      active.once('error', onClose)
      const consumeResult = await active.consume(options.queue, message => {
        if (!message || !running) return
        const work = processConsumerMessage(active, message, options).catch(error => {
          logError(options.logger, 'Unexpected consumer failure', {
            eventId: message.properties.messageId,
            eventType: eventTypeHint(message)
          })
          try { active.nack(message, false, true) } catch { /* the broker will requeue on channel loss */ }
        }).finally(() => inFlight.delete(work))
        inFlight.add(work)
      }, { noAck: false })
      consumerTag = consumeResult.consumerTag
    } catch (error) {
      if (activeChannel === channel) activeChannel = undefined
      if (activeConnection === connection) activeConnection = undefined
      consumerTag = undefined
      signalDisconnect = undefined
      disconnected = undefined
      await channel?.close().catch(() => {})
      await connection.close().catch(() => {})
      throw error
    }
  }

  async function closeCurrent(): Promise<void> {
    const channel = activeChannel
    const connection = activeConnection
    if (channel && consumerTag) await channel.cancel(consumerTag).catch(() => {})
    await settleInFlight()
    if (activeChannel === channel) activeChannel = undefined
    if (activeConnection === connection) activeConnection = undefined
    consumerTag = undefined
    signalDisconnect = undefined
    disconnected = undefined
    await channel?.close().catch(() => {})
    await connection?.close().catch(() => {})
  }

  async function reconnectLoop(): Promise<void> {
    let reconnectAttempt = 0
    while (running) {
      if (disconnected) await disconnected
      await closeCurrent()
      if (!running) return
      const waitMs = Math.min(30000, reconnectDelayMs * 2 ** reconnectAttempt)
      await delay(waitMs, undefined, { signal: reconnectController?.signal }).catch(() => {})
      if (!running) return
      try {
        await connectOnce()
        reconnectAttempt = 0
      } catch (error) {
        reconnectAttempt += 1
        logError(options.logger, 'Consumer connection failed; reconnecting', {})
      }
    }
  }

  return {
    async start() {
      if (running) return
      running = true
      reconnectController = new AbortController()
      try {
        await connectOnce()
        supervisor = reconnectLoop()
      } catch (error) {
        running = false
        reconnectController.abort()
        await activeChannel?.close().catch(() => {})
        await activeConnection?.close().catch(() => {})
        activeChannel = undefined
        activeConnection = undefined
        throw error
      }
    },
    async stop() {
      if (!running) return
      running = false
      reconnectController?.abort()
      const channel = activeChannel
      const connection = activeConnection
      if (channel && consumerTag) await channel.cancel(consumerTag).catch(() => {})
      await settleInFlight()
      signalDisconnect?.()
      await supervisor
      await channel?.close().catch(() => {})
      await connection?.close().catch(() => {})
      activeChannel = undefined
      activeConnection = undefined
    }
  }
}
