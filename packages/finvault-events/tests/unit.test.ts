import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mock, test } from 'node:test'
import amqp, { type Channel, type ChannelModel, type ConfirmChannel, type ConsumeMessage, type Options } from 'amqplib'
import { publishConfirmed } from '../src/broker'
import { assertConsumerTopology, createConsumer, NonRetryableError, processConsumerMessage } from '../src/consumer'
import { createInMemoryInbox } from '../src/inbox'
import type { EventHandler, InboxAdapter } from '../src/inbox'
import { createPublisher } from '../src/publisher'
import { createEventFromOutbox, createSingleFlight } from '../src/outbox'
import { addAmounts, compareAmounts } from '../src/money'
import {
  eventPayloadHash,
  EventValidationError,
  parseFinvaultEvent,
  paymentExpiredSchema,
  paymentFailedSchema,
  paymentSucceededSchema,
  userKycUpdatedLegacySchema,
  userKycUpdatedSchema,
  userRegisteredSchema,
  merchantStatusUpdatedSchema,
  walletLimitExceededSchema
} from '../src/schemas'

const uuid = 'd0a1b4a4-e65c-4a5c-8c84-835bc31e3981'
const occurredAt = '2026-10-20T10:00:00.000Z'

function envelope(eventType: string, data: unknown, eventVersion = 1) {
  return { eventId: uuid, eventType, eventVersion, occurredAt, data }
}

class FakeConfirmChannel extends EventEmitter {
  mode: 'confirm' | 'nack' | 'timeout' | 'return' = 'confirm'
  published: Array<{ exchange: string; key: string; content: Buffer; options: Record<string, unknown> }> = []
  acked = 0
  nacked: boolean[] = []
  manualConfirm = false
  private pendingConfirms: Array<() => void> = []

  publish(
    exchange: string,
    key: string,
    content: Buffer,
    options: Record<string, unknown>,
    callback?: (error: Error | null) => void
  ): boolean {
    this.published.push({ exchange, key, content, options })
    if (this.mode === 'timeout') return true
    if (this.manualConfirm) {
      this.pendingConfirms.push(() => {
        if (this.mode === 'return') this.emit('return', { properties: { messageId: options.messageId } })
        callback?.(this.mode === 'nack' ? new Error('broker nack') : null)
      })
      return true
    }
    queueMicrotask(() => {
      if (this.mode === 'return') this.emit('return', { properties: { messageId: options.messageId } })
      callback?.(this.mode === 'nack' ? new Error('broker nack') : null)
    })
    return true
  }

  ack(): void {
    this.acked += 1
  }

  nack(_message: ConsumeMessage, _allUpTo: boolean, requeue: boolean): void {
    this.nacked.push(requeue)
  }

  confirmNext(): void {
    this.pendingConfirms.shift()?.()
  }
}

class FakePublisherChannel extends EventEmitter {
  assertExchangeStarted!: () => void
  assertExchangeGate?: Promise<void>
  failAssertExchange = false
  publishCalls = 0
  closeCalls = 0

  async assertExchange(): Promise<void> {
    this.assertExchangeStarted?.()
    if (this.assertExchangeGate) await this.assertExchangeGate
    if (this.failAssertExchange) throw new Error('assertExchange failed')
  }

  publish(
    _exchange: string,
    _routingKey: string,
    _content: Buffer,
    _options: Options.Publish,
    callback?: (error: Error | null) => void
  ): boolean {
    this.publishCalls += 1
    queueMicrotask(() => callback?.(null))
    return true
  }

  async close(): Promise<void> {
    this.closeCalls += 1
    this.emit('close')
  }
}

class FakePublisherConnection extends EventEmitter {
  closeCalls = 0
  lateClose?: () => void

  constructor(readonly channel: FakePublisherChannel) {
    super()
  }

  async createConfirmChannel(): Promise<FakePublisherChannel> {
    return this.channel
  }

  async close(): Promise<void> {
    this.closeCalls += 1
    this.emit('close')
  }

  fireLateClose(): void {
    this.lateClose?.()
  }
}

const confirmChannel = (channel: FakeConfirmChannel) => channel as unknown as ConfirmChannel

function delivery(
  eventType: string,
  data: unknown,
  eventId = uuid,
  headers: Record<string, unknown> = {},
  routingKey = eventType
): ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify({ ...envelope(eventType, data), eventId })),
    fields: { exchange: 'finvault.events', routingKey },
    properties: { messageId: eventId, type: eventType, headers }
  } as unknown as ConsumeMessage
}

function consumerOptions(
  inbox = createInMemoryInbox(),
  handlers: Record<string, EventHandler>
): Parameters<typeof processConsumerMessage>[2] {
  return {
    url: 'amqp://unit',
    queue: 'unit.finvault.events',
    bindings: ['#'],
    inbox,
    handlers
  }
}

test('validates envelope and every registered event payload', () => {
  const fixtures: Array<[string, unknown, (value: unknown) => boolean]> = [
    ['user.registered', { authUserId: 'auth-1', email: 'a@example.com', phone: '123' }, value => userRegisteredSchema.safeParse(value).success],
    ['user.kyc_updated', { authUserId: 'auth-1', kycTier: 2, previousTier: 1 }, value => userKycUpdatedSchema.safeParse(value).success],
    ['merchant.status_updated', { merchantId: 'merchant-1', status: 'ACTIVE' }, value => merchantStatusUpdatedSchema.safeParse(value).success],
    ['payment.succeeded', { paymentId: 'payment-1', senderId: 'u1', receiverId: 'u2', amount: '123' }, value => paymentSucceededSchema.safeParse(value).success],
    ['payment.failed', { paymentId: 'payment-1', senderId: 'u1', reason: 'DECLINED' }, value => paymentFailedSchema.safeParse(value).success],
    ['payment.expired', { paymentId: 'payment-1', senderId: 'u1' }, value => paymentExpiredSchema.safeParse(value).success],
    ['wallet.limit_exceeded', { userId: 'u1', limitType: 'DAILY', kycTier: 1 }, value => walletLimitExceededSchema.safeParse(value).success]
  ]
  for (const [eventType, data, validate] of fixtures) {
    assert.equal(validate(data), true, `${eventType} payload should satisfy its schema`)
    assert.equal(parseFinvaultEvent(envelope(eventType, data)).eventType, eventType)
  }
  assert.throws(() => parseFinvaultEvent({ ...envelope('payment.expired', { paymentId: 'p', senderId: 'u' }), eventId: 'bad' }),
    error => error instanceof EventValidationError && error.reason === 'INVALID_ENVELOPE')
  assert.throws(() => parseFinvaultEvent(envelope('unknown.event', {})),
    error => error instanceof EventValidationError && error.reason === 'UNKNOWN_EVENT_TYPE')
  assert.throws(() => parseFinvaultEvent(envelope('payment.expired', { paymentId: 'p', senderId: 'u' }, 2)),
    error => error instanceof EventValidationError && error.reason === 'UNSUPPORTED_EVENT_VERSION')
})

test('rejects malformed money and required KYC fields; legacy parsing is opt-in and does not invent a tier', () => {
  for (const amount of [12, '-1', '1.2', '1e3', '', '1\n']) {
    assert.equal(paymentSucceededSchema.safeParse({
      paymentId: 'p', senderId: 'u1', receiverId: 'u2', amount
    }).success, false)
  }
  const legacy = envelope('user.kyc_updated', { authUserId: 'auth-1', kycTier: 2 })
  assert.equal(userKycUpdatedLegacySchema.safeParse(legacy.data).success, true)
  assert.throws(() => parseFinvaultEvent(legacy), EventValidationError)
  const adapted = parseFinvaultEvent(legacy, { allowLegacyKycUpdated: true })
  assert.deepEqual(adapted.data, { authUserId: 'auth-1', kycTier: 2, previousTier: undefined, legacy: true })
  assert.equal(eventPayloadHash(adapted), eventPayloadHash({
    eventType: 'user.kyc_updated', eventVersion: 1, data: legacy.data
  }))
  const additive = parseFinvaultEvent(envelope('user.kyc_updated', {
    authUserId: 'auth-1', kycTier: 2, previousTier: 1, futureField: true
  }))
  assert.equal((additive.data as Record<string, unknown>).futureField, true)
})

test('hashes normalized event data without occurredAt and uses exact integer arithmetic', () => {
  const first = { eventType: 'payment.succeeded', eventVersion: 1, data: { amount: '99', paymentId: 'p' } }
  const second = { eventType: 'payment.succeeded', eventVersion: 1, data: { paymentId: 'p', amount: '99' } }
  assert.equal(eventPayloadHash(first), eventPayloadHash(second))
  assert.equal(addAmounts('999999999999999999', '1'), '1000000000000000000')
  assert.equal(compareAmounts('100', '99'), 1)
  assert.throws(() => addAmounts('1.0', '2'), TypeError)
  assert.throws(() => addAmounts('1\n', '2'), TypeError)
})

test('builds a validated envelope from an outbox row using its ID and UTC creation time', () => {
  const event = createEventFromOutbox(
    { id: uuid, createdAt: new Date('2026-10-20T10:00:00-07:00') },
    'payment.succeeded',
    { paymentId: 'p-1', senderId: 'u1', receiverId: 'u2', amount: '50000', note: 'Rent' }
  )

  assert.deepEqual(event, {
    eventId: uuid,
    eventType: 'payment.succeeded',
    eventVersion: 1,
    occurredAt: '2026-10-20T17:00:00.000Z',
    data: { paymentId: 'p-1', senderId: 'u1', receiverId: 'u2', amount: '50000', note: 'Rent' }
  })
  assert.throws(() => createEventFromOutbox(
    { id: 'not-a-uuid', createdAt: new Date() },
    'payment.expired',
    { paymentId: 'p-1', senderId: 'u1' }
  ), EventValidationError)
  assert.throws(() => createEventFromOutbox(
    { id: uuid, createdAt: 'invalid' },
    'payment.expired',
    { paymentId: 'p-1', senderId: 'u1' }
  ), TypeError)
})

test('single-flight outbox drains do not overlap and can run again after completion', async () => {
  let release!: () => void
  let calls = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const drain = createSingleFlight(async () => {
    calls += 1
    await gate
  })

  const first = drain()
  const concurrent = drain()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  release()
  await Promise.all([first, concurrent])
  await drain()
  assert.equal(calls, 2)
})

test('in-memory inbox processes once, detects duplicate/conflict, and commits only after handler success', async () => {
  const inbox = createInMemoryInbox()
  let calls = 0
  const args = { eventId: uuid, eventType: 'payment.expired', payloadHash: 'hash-a' }
  const handler = async () => { calls += 1; return 'done' }
  assert.deepEqual(await inbox.runOnce(args, handler), { status: 'processed', result: 'done' })
  assert.deepEqual(await inbox.runOnce(args, handler), { status: 'duplicate' })
  assert.deepEqual(await inbox.runOnce({ ...args, payloadHash: 'hash-b' }, handler), { status: 'conflict' })
  assert.equal(calls, 1)
  await assert.rejects(inbox.runOnce({ ...args, eventId: 'new-event' }, async () => { throw new Error('rollback') }))
  assert.deepEqual(await inbox.runOnce({ ...args, eventId: 'new-event' }, async () => 'retried'),
    { status: 'processed', result: 'retried' })
})

test('confirmed publish resolves only after confirm and rejects nack, timeout, return, and channel loss', async () => {
  const body = Buffer.from('{}')
  const confirmed = new FakeConfirmChannel()
  await publishConfirmed(confirmChannel(confirmed), '', 'queue', body, { messageId: uuid }, 100)
  assert.equal(confirmed.published[0].options.mandatory, true)

  const nacked = new FakeConfirmChannel()
  nacked.mode = 'nack'
  await assert.rejects(publishConfirmed(confirmChannel(nacked), '', 'queue', body, {}, 100), /broker nack/)

  const timedOut = new FakeConfirmChannel()
  timedOut.mode = 'timeout'
  await assert.rejects(publishConfirmed(confirmChannel(timedOut), '', 'queue', body, {}, 5),
    error => (error as { code?: string }).code === 'PUBLISH_TIMEOUT')

  const returned = new FakeConfirmChannel()
  returned.mode = 'return'
  await assert.rejects(publishConfirmed(confirmChannel(returned), '', 'queue', body, { messageId: uuid }, 100),
    error => (error as { code?: string }).code === 'UNROUTABLE_EVENT')

  const disconnected = new FakeConfirmChannel()
  const pending = publishConfirmed(confirmChannel(disconnected), '', 'queue', body, {}, 1000)
  disconnected.emit('close')
  await assert.rejects(pending, error => (error as { code?: string }).code === 'CHANNEL_CLOSED')
})

test('concurrent confirmed publishes share one return and close listener per channel', async () => {
  const channel = new FakeConfirmChannel()
  channel.manualConfirm = true
  const pending = Array.from({ length: 25 }, (_, index) =>
    publishConfirmed(confirmChannel(channel), '', 'queue', Buffer.from('{}'), {
      messageId: `event-${index}`
    }, 1000))
  assert.equal(channel.listenerCount('return'), 1)
  assert.equal(channel.listenerCount('close'), 1)
  for (let index = 0; index < pending.length; index += 1) channel.confirmNext()
  await Promise.all(pending)
  assert.equal(channel.listenerCount('return'), 1)
  assert.equal(channel.listenerCount('close'), 1)
})

test('consumer topology declares durable queues and exact bindings', async () => {
  const calls: unknown[][] = []
  const fake = {
    assertExchange: async (...args: unknown[]) => { calls.push(['exchange', ...args]) },
    assertQueue: async (...args: unknown[]) => { calls.push(['queue', ...args]) },
    bindQueue: async (...args: unknown[]) => { calls.push(['bind', ...args]) }
  } as unknown as Channel
  await assertConsumerTopology(fake, {
    queue: 'unit.finvault.events',
    bindings: ['user.#', 'payment.#'],
    retryDelaysMs: [1000, 5000, 1000]
  })
  assert.deepEqual(calls.filter(([kind]) => kind === 'bind'), [
    ['bind', 'unit.finvault.events', 'finvault.events', 'user.#'],
    ['bind', 'unit.finvault.events', 'finvault.events', 'payment.#']
  ])
  assert.deepEqual(calls.filter(([kind]) => kind === 'queue').map(call => call[1]), [
    'unit.finvault.events',
    'unit.finvault.events.retry.1000',
    'unit.finvault.events.retry.5000',
    'unit.finvault.events.dlq'
  ])
  assert.deepEqual(calls.filter(([kind, name]) => kind === 'queue' && name !== 'unit.finvault.events.dlq')
    .slice(1).map(call => call[2]), [
    {
      durable: true,
      arguments: {
        'x-message-ttl': 1000,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': 'unit.finvault.events'
      }
    },
    {
      durable: true,
      arguments: {
        'x-message-ttl': 5000,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': 'unit.finvault.events'
      }
    }
  ])
})

test('consumer waits for the handler before ack, suppresses duplicates, and dead-letters conflicts', async () => {
  const inbox = createInMemoryInbox()
  const channel = new FakeConfirmChannel()
  let handlerCalls = 0
  let finishHandler!: () => void
  const options = consumerOptions(inbox, {
    'payment.expired': async () => {
      handlerCalls += 1
      await new Promise<void>(resolve => { finishHandler = resolve })
    }
  })
  const message = delivery('payment.expired', { paymentId: 'p1', senderId: 'u1' })
  const processing = processConsumerMessage(confirmChannel(channel), message, options)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(channel.acked, 0, 'delivery must remain unacked while the handler runs')
  finishHandler()
  await processing
  assert.equal(channel.acked, 1)

  await processConsumerMessage(confirmChannel(channel), delivery('payment.expired', { paymentId: 'p1', senderId: 'u1' }), options)
  assert.equal(handlerCalls, 1)
  assert.equal(channel.acked, 2)

  await processConsumerMessage(confirmChannel(channel), delivery('payment.expired', { paymentId: 'p2', senderId: 'u1' }), options)
  assert.equal(channel.acked, 3)
  assert.equal(channel.published.at(-1)?.key, 'unit.finvault.events.dlq')
  assert.equal(channel.published.at(-1)?.options.headers && (channel.published.at(-1)!.options.headers as Record<string, unknown>)['x-dlq-reason'],
    'EVENT_CONFLICT')
})

test('consumer confirms TTL retry before ack, dead-letters permanent failures, and requeues if retry publish fails', async () => {
  const failed = new FakeConfirmChannel()
  failed.manualConfirm = true
  const logs: string[] = []
  const failingOptions = consumerOptions(createInMemoryInbox(), {
    'payment.expired': async () => { throw new Error('temporary') }
  })
  failingOptions.maxRetries = 1
  failingOptions.retryDelaysMs = [77]
  failingOptions.logger = { error: message => logs.push(message) }
  const retrying = processConsumerMessage(confirmChannel(failed),
    delivery('payment.expired', { paymentId: 'p1', senderId: 'u1' }, uuid, { Authorization: 'sensitive' }), failingOptions)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(failed.acked, 0, 'original delivery must remain unacked before retry confirm')
  failed.confirmNext()
  await retrying
  assert.equal(failed.published[0].key, 'unit.finvault.events.retry.77')
  assert.equal(failed.published[0].options.expiration, undefined)
  assert.equal((failed.published[0].options.headers as Record<string, unknown>)['x-retry-count'], 1)
  assert.equal('Authorization' in (failed.published[0].options.headers as Record<string, unknown>), false)
  assert.equal(failed.acked, 1)

  const exhausted = new FakeConfirmChannel()
  await processConsumerMessage(confirmChannel(exhausted),
    delivery('payment.expired', { paymentId: 'p2', senderId: 'u1' }, uuid, { 'x-retry-count': 1 }),
    failingOptions)
  assert.equal((exhausted.published[0].options.headers as Record<string, unknown>)['x-dlq-reason'], 'MAX_RETRIES_EXCEEDED')
  assert.equal(exhausted.acked, 1)

  const permanent = new FakeConfirmChannel()
  const permanentOptions = consumerOptions(createInMemoryInbox(), {
    'payment.expired': async () => { throw new NonRetryableError('invalid domain state', 'INVALID_STATE') }
  })

  await processConsumerMessage(confirmChannel(permanent),
    delivery('payment.expired', { paymentId: 'p3', senderId: 'u1' }), permanentOptions)
  assert.equal((permanent.published[0].options.headers as Record<string, unknown>)['x-dlq-reason'], 'INVALID_STATE')
  assert.equal(permanent.published.length, 1)

  const unknown = new FakeConfirmChannel()
  await processConsumerMessage(confirmChannel(unknown),
    delivery('unregistered.event', {}), consumerOptions(createInMemoryInbox(), {}))
  assert.equal((unknown.published[0].options.headers as Record<string, unknown>)['x-dlq-reason'], 'UNKNOWN_EVENT_TYPE')

  const republishFailure = new FakeConfirmChannel()
  republishFailure.mode = 'nack'
  await processConsumerMessage(confirmChannel(republishFailure),
    delivery('payment.expired', { paymentId: 'p4', senderId: 'u1' }), failingOptions)
  assert.equal(republishFailure.acked, 0)
  assert.deepEqual(republishFailure.nacked, [true])
  assert.ok(logs.includes('RETRY_PUBLISH_FAILED'))
})

test('ignored events are acknowledged without handler or inbox; missing handlers still dead-letter', async () => {
  let inboxCalls = 0
  const infos: Array<{ message: string; context: unknown }> = []
  const channel = new FakeConfirmChannel()
  const inbox: InboxAdapter = {
    async runOnce() {
      inboxCalls += 1
      return { status: 'duplicate' as const }
    }
  }
  const options = consumerOptions(inbox, {})
  options.ignoredEventTypes = ['user.registered']
  options.logger = { info: (message, context) => infos.push({ message, context }) }

  await processConsumerMessage(confirmChannel(channel),
    delivery('user.registered', { authUserId: 'auth-1', email: 'a@example.com' }), options)
  assert.equal(channel.acked, 1)
  assert.equal(channel.published.length, 0)
  assert.equal(inboxCalls, 0)
  assert.deepEqual(infos, [{
    message: 'Ignoring configured FinVault event',
    context: { eventId: uuid, eventType: 'user.registered' }
  }])

  await processConsumerMessage(confirmChannel(channel),
    delivery('payment.expired', { paymentId: 'p1', senderId: 'u1' }), options)
  assert.equal(channel.acked, 2)
  assert.equal(channel.published.at(-1)?.key, 'unit.finvault.events.dlq')
  assert.equal((channel.published.at(-1)?.options.headers as Record<string, unknown>)['x-dlq-reason'], 'NO_HANDLER')

  await processConsumerMessage(confirmChannel(channel),
    delivery('unregistered.event', {}), options)
  assert.equal((channel.published.at(-1)?.options.headers as Record<string, unknown>)['x-dlq-reason'], 'UNKNOWN_EVENT_TYPE')
})

test('consumer rejects invalid ignored-event configuration', () => {
  assert.throws(() => createConsumer({
    ...consumerOptions(createInMemoryInbox(), { 'user.registered': async () => undefined }),
    ignoredEventTypes: ['user.registered']
  }), TypeError)
  for (const ignoredEventTypes of [[''], [3], [null]] as unknown[][]) {
    const options = consumerOptions(createInMemoryInbox(), {})
    Reflect.set(options, 'ignoredEventTypes', ignoredEventTypes)
    assert.throws(() => createConsumer(options), TypeError)
  }
})

test('publisher shares the initial connection promise until exchange assertion finishes', async () => {
  let releaseAssert!: () => void
  const assertGate = new Promise<void>(resolve => { releaseAssert = resolve })
  let assertStarted!: () => void
  const started = new Promise<void>(resolve => { assertStarted = resolve })
  const channel = new FakePublisherChannel()
  channel.assertExchangeGate = assertGate
  channel.assertExchangeStarted = assertStarted
  const connection = new FakePublisherConnection(channel)
  const connect = mock.method(amqp, 'connect', async () => connection as unknown as ChannelModel)
  const publisher = createPublisher({ url: 'amqp://publisher-test', confirmTimeoutMs: 1000 })
  const first = publisher.publish(envelope('payment.expired', { paymentId: 'p1', senderId: 'u1' }))

  await started
  const second = publisher.publish({
    ...envelope('payment.expired', { paymentId: 'p2', senderId: 'u2' }),
    eventId: '2c1e97f9-5668-4319-af59-142c1f353101'
  })
  await new Promise<void>(resolve => setImmediate(resolve))
  const publishedBeforeExchangeReady = channel.publishCalls
  releaseAssert()
  const results = await Promise.allSettled([first, second])
  await publisher.close()
  connect.mock.restore()

  assert.equal(publishedBeforeExchangeReady, 0, 'publishes must wait for assertExchange')
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled'])
})

test('late close from a replaced publisher connection does not discard the new connection', async () => {
  const channelA = new FakePublisherChannel()
  const channelB = new FakePublisherChannel()
  const connectionA = new FakePublisherConnection(channelA)
  const connectionB = new FakePublisherConnection(channelB)
  let connections = 0
  const connect = mock.method(amqp, 'connect', async () => {
    connections += 1
    return (connections === 1 ? connectionA : connectionB) as unknown as ChannelModel
  })
  const publisher = createPublisher({ url: 'amqp://publisher-test', confirmTimeoutMs: 1000 })
  await publisher.publish(envelope('payment.expired', { paymentId: 'p1', senderId: 'u1' }))
  connectionA.lateClose = connectionA.listeners('close')[0] as (() => void) | undefined
  connectionA.emit('close')
  await publisher.publish(envelope('payment.expired', { paymentId: 'p2', senderId: 'u1' }))
  connectionA.fireLateClose()
  await publisher.publish({
    ...envelope('payment.expired', { paymentId: 'p3', senderId: 'u1' }),
    eventId: '8a20cb32-0d76-4a86-9f84-5bb2cb3a7510'
  })

  assert.equal(connections, 2, 'the next publish must reuse B rather than open connection C')
  assert.equal(channelB.publishCalls, 2)
  await publisher.close()
  connect.mock.restore()
})

test('publisher closes a connection whose exchange assertion fails, then reconnects successfully', async () => {
  const failedChannel = new FakePublisherChannel()
  failedChannel.failAssertExchange = true
  const failedConnection = new FakePublisherConnection(failedChannel)
  const successfulChannel = new FakePublisherChannel()
  const successfulConnection = new FakePublisherConnection(successfulChannel)
  let connections = 0
  const connect = mock.method(amqp, 'connect', async () => {
    connections += 1
    return (connections === 1 ? failedConnection : successfulConnection) as unknown as ChannelModel
  })
  const publisher = createPublisher({ url: 'amqp://publisher-test', confirmTimeoutMs: 1000 })

  await publisher.publish(envelope('payment.expired', { paymentId: 'p1', senderId: 'u1' }))

  assert.equal(failedChannel.closeCalls, 1)
  assert.equal(failedConnection.closeCalls, 1)
  assert.equal(successfulChannel.publishCalls, 1)
  assert.equal(connections, 2)
  await publisher.close()
  connect.mock.restore()
})
