import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type { Channel, ConfirmChannel, ConsumeMessage } from 'amqplib'
import { publishConfirmed } from '../src/broker'
import { assertConsumerTopology, NonRetryableError, processConsumerMessage } from '../src/consumer'
import { createInMemoryInbox } from '../src/inbox'
import type { EventHandler } from '../src/inbox'
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

test('consumer topology declares durable queues and exact bindings', async () => {
  const calls: unknown[][] = []
  const fake = {
    assertExchange: async (...args: unknown[]) => { calls.push(['exchange', ...args]) },
    assertQueue: async (...args: unknown[]) => { calls.push(['queue', ...args]) },
    bindQueue: async (...args: unknown[]) => { calls.push(['bind', ...args]) }
  } as unknown as Channel
  await assertConsumerTopology(fake, { queue: 'unit.finvault.events', bindings: ['user.#', 'payment.#'] })
  assert.deepEqual(calls.filter(([kind]) => kind === 'bind'), [
    ['bind', 'unit.finvault.events', 'finvault.events', 'user.#'],
    ['bind', 'unit.finvault.events', 'finvault.events', 'payment.#']
  ])
  assert.deepEqual(calls.filter(([kind]) => kind === 'queue').map(call => call[1]), [
    'unit.finvault.events',
    'unit.finvault.events.retry',
    'unit.finvault.events.dlq'
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
  assert.equal(failed.published[0].key, 'unit.finvault.events.retry')
  assert.equal(failed.published[0].options.expiration, '77')
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
