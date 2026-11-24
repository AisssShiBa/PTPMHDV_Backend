import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Prisma } from '@prisma/client'
import { EventValidationError, eventPayloadHash, type FinvaultEvent } from 'finvault-events'
import { buildPaymentFinvaultEvent } from '../src/events/finvault.publisher'
import { processPaymentOutboxEvent, type PaymentEventActions } from '../src/jobs/payment-outbox-event'

const row = (eventType: string, payload: Prisma.JsonObject) => ({
  id: '00000000-0000-4000-8000-000000000001',
  aggregateId: 'payment-1',
  createdAt: new Date('2026-10-30T12:00:00Z'),
  eventType,
  payload
})

test('preserves durable P2P envelopes and rejects mismatched outbox identities', () => {
  const envelope = {
    eventId: '00000000-0000-4000-8000-000000000001',
    eventType: 'payment.succeeded', eventVersion: 1,
    occurredAt: '2026-10-30T12:00:00.000Z',
    data: { paymentId: 'payment-1', senderId: 'sender', receiverId: 'receiver', amount: '50000' }
  }
  assert.deepEqual(buildPaymentFinvaultEvent(row(envelope.eventType, envelope)), envelope)
  assert.throws(() => buildPaymentFinvaultEvent(row(envelope.eventType, {
    ...envelope, eventId: '00000000-0000-4000-8000-000000000002'
  })), /does not match/)
})

test('maps successful payment outbox rows to the versioned event envelope', () => {
  assert.deepEqual(buildPaymentFinvaultEvent(row('PAYMENT_SUCCESS', {
    id: 'payment-1',
    userId: 'sender',
    destinationUserId: 'receiver',
    amount: '50000.00',
    note: 'Dinner'
  })), {
    eventId: '00000000-0000-4000-8000-000000000001',
    eventType: 'payment.succeeded',
    eventVersion: 1,
    occurredAt: '2026-10-30T12:00:00.000Z',
    data: {
      paymentId: 'payment-1',
      senderId: 'sender',
      receiverId: 'receiver',
      amount: '50000',
      note: 'Dinner'
    }
  })
})

test('maps failed and expired payments to their notification contract payloads', () => {
  assert.deepEqual(buildPaymentFinvaultEvent(row('PAYMENT_FAILED', {
    id: 'payment-2',
    userId: 'sender',
    failureReason: 'DECLINED'
  }))?.data, {
    paymentId: 'payment-2',
    senderId: 'sender',
    reason: 'DECLINED'
  })
  assert.deepEqual(buildPaymentFinvaultEvent(row('PAYMENT_EXPIRED', {
    id: 'payment-3',
    userId: 'sender'
  }))?.data, {
    paymentId: 'payment-3',
    senderId: 'sender'
  })
})

test('leaves legacy payment event types to their existing publisher and rejects fractional VND', () => {
  assert.equal(buildPaymentFinvaultEvent(row('PAYMENT_REFUNDED', { userId: 'sender' })), undefined)
  assert.throws(() => buildPaymentFinvaultEvent(row('PAYMENT_SUCCESS', {
    id: 'payment-4',
    userId: 'sender',
    destinationUserId: 'receiver',
    amount: '50.25'
  })), /whole VND/)
})

function refundPayload(): Prisma.JsonObject {
  return {
    paymentId: 'payment-1', userId: 'sender', destinationUserId: null,
    amount: '50000.00', status: 'REFUNDED', referenceId: 'refund_payment-1',
    walletTransactionId: '00000000-0000-4000-8000-000000000002',
    refundedAt: '2026-10-30T11:59:59.000Z'
  }
}

const refundRow = (payload: Prisma.JsonObject = refundPayload(), retryCount = 0) => ({
  ...row('payment.refunded', payload), payload, retryCount
})

test('wraps the refund worker payload without losing metadata or changing the outbox identity', () => {
  const outbox = refundRow()
  const original = structuredClone(outbox)
  const event = buildPaymentFinvaultEvent(outbox)
  assert.deepEqual(event, {
    eventId: outbox.id, eventType: 'payment.refunded', eventVersion: 1,
    occurredAt: '2026-10-30T12:00:00.000Z', data: outbox.payload
  })
  assert.deepEqual(outbox, original)
  assert.ok(event)
  const replay = buildPaymentFinvaultEvent(refundRow(outbox.payload, 1))
  assert.ok(replay)
  assert.deepEqual(replay, event)
  assert.equal(eventPayloadHash(replay), eventPayloadHash(event))
})

test('accepts whole VND refund strings exactly, including values beyond Number precision', () => {
  for (const amount of ['1', '1.00', '50000', '50000.00', '9007199254740993.00', '999999999999999999.00']) {
    const payload = { ...refundPayload(), amount }
    assert.deepEqual(buildPaymentFinvaultEvent(refundRow(payload))?.data, payload)
  }
})

test('rejects malformed refund amounts and missing recipient/payment fields', () => {
  for (const amount of [0, 50000, null, '', '0', '0.00', '-1', '1.50', '1e4', ' 50000', '050000', '1000000000000000000.00']) {
    assert.throws(() => buildPaymentFinvaultEvent(refundRow({ ...refundPayload(), amount })),
      error => error instanceof EventValidationError && error.reason === 'INVALID_PAYLOAD')
  }
  for (const field of ['paymentId', 'userId', 'amount']) {
    const payload = refundPayload()
    delete payload[field]
    assert.throws(() => buildPaymentFinvaultEvent(refundRow(payload)),
      error => error instanceof EventValidationError && error.reason === 'INVALID_PAYLOAD')
  }
})

test('preserves a refund envelope and rejects mismatched event/payment identities and versions', () => {
  const payload = refundPayload()
  const event = buildPaymentFinvaultEvent(refundRow(payload))
  assert.ok(event)
  assert.deepEqual(buildPaymentFinvaultEvent(refundRow({ ...event, data: payload })), event)
  assert.throws(() => buildPaymentFinvaultEvent(refundRow({ ...payload, paymentId: 'other-payment' })), /does not match/)
  assert.throws(() => buildPaymentFinvaultEvent(refundRow({ ...event, data: payload,
    eventId: '00000000-0000-4000-8000-000000000003' })), /does not match/)
  assert.throws(() => buildPaymentFinvaultEvent(refundRow({ ...event, data: { paymentId: 'other-payment', userId: 'sender', amount: '50000' } })), /does not match/)
  assert.throws(() => buildPaymentFinvaultEvent(refundRow({ ...event, eventType: 'payment.expired',
    data: { paymentId: 'payment-1', senderId: 'sender' } })), /does not match/)
  assert.throws(() => buildPaymentFinvaultEvent(refundRow({ ...event, data: payload, eventVersion: 2 })),
    error => error instanceof EventValidationError && error.reason === 'UNSUPPORTED_EVENT_VERSION')
})

test('keeps refund workflow requests/failures with their existing worker instead of publishing a completed refund', () => {
  for (const eventType of ['payment.refund_requested', 'payment.refund_failed']) {
    assert.equal(buildPaymentFinvaultEvent({ ...refundRow(), eventType }), undefined)
  }
})

test('does not mark a refund SENT while its publish confirmation is still pending', async () => {
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const confirmed = new Promise<void>(resolve => { release = resolve })
  const order: string[] = []
  const result = processPaymentOutboxEvent(refundRow(), {
    publish: async () => { order.push('publish'); entered(); await confirmed; order.push('confirmed') },
    markSent: async () => { order.push('sent') },
    markFailed: async () => assert.fail('valid refund must not fail'),
    scheduleRetry: async () => assert.fail('successful publish must not retry')
  })
  try {
    await Promise.race([waiting, result.then(() => assert.fail('publish must be reached'))])
    assert.deepEqual(order, ['publish'])
  } finally { release() }
  assert.equal(await result, 'sent')
  assert.deepEqual(order, ['publish', 'confirmed', 'sent'])
})

test('retries refund transport failures with the same event and marks SENT only after success', async () => {
  const events: FinvaultEvent[] = []
  const delays: number[] = []
  let sent = 0
  const actions: PaymentEventActions = {
    publish: async event => { events.push(event); if (events.length < 3) throw new Error('synthetic broker unavailable') },
    markSent: async () => { sent++ },
    markFailed: async () => assert.fail('transport failure must remain retryable'),
    scheduleRetry: async delay => { delays.push(delay) }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(sent, 0)
    assert.equal(await processPaymentOutboxEvent(refundRow(refundPayload(), attempt), actions), attempt < 2 ? 'retry' : 'sent')
  }
  assert.equal(sent, 1)
  assert.deepEqual(delays, [1000, 2000])
  assert.equal(events.length, 3)
  assert.deepEqual(events[1], events[0])
  assert.deepEqual(events[2], events[0])
})

test('invalid refund payload is FAILED without publishing or acknowledging it as SENT', async () => {
  let failed = 0
  const result = await processPaymentOutboxEvent(refundRow({ ...refundPayload(), amount: '12.50' }), {
    publish: async () => assert.fail('invalid refund must not publish'),
    markSent: async () => assert.fail('invalid refund must not be marked SENT'),
    markFailed: async error => {
      assert.ok(error instanceof EventValidationError)
      failed++
    },
    scheduleRetry: async () => assert.fail('invalid payload must not be retried')
  })
  assert.equal(result, 'failed')
  assert.equal(failed, 1)
})
