import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createInMemoryInbox,
  eventSchemaRegistry,
  NonRetryableError,
  parseFinvaultEvent,
  type FinvaultEvent
} from 'finvault-events'
import {
  createFinanceEventHandlers,
  financeEventBindings
} from '../src/services/financeEventsConsumer'
import type { UserLookupClient } from '../src/services/userLookup'

const event = (eventType: string, data: unknown, eventId = '00000000-0000-4000-8000-000000000010'): FinvaultEvent => ({
  eventId,
  eventType,
  eventVersion: 1,
  occurredAt: '2026-01-01T00:00:00.000Z',
  data
})

const inertLookup: UserLookupClient = {
  async getFullName() {
    return null
  }
}

interface NotificationRow {
  id: string
  eventId: string
  userId: string
  type: string
  message: string
}

const createFakeTransaction = () => {
  const rows: NotificationRow[] = []
  const afterCommitCallbacks: Array<() => void | Promise<void>> = []
  const context = {
    prisma: {
      notification: {
        create: async ({ data }: { data: Omit<NotificationRow, 'id'> }) => {
          const row: NotificationRow = { id: `notification-${rows.length + 1}`, ...data }
          rows.push(row)
          return row
        }
      }
    },
    afterCommit: (callback: () => void | Promise<void>) => {
      afterCommitCallbacks.push(callback)
    }
  }
  return {
    context,
    rows,
    runAfterCommit: async () => {
      for (const callback of afterCommitCallbacks) await callback()
    }
  }
}

const handlers = createFinanceEventHandlers(inertLookup, async (id, message) => ({
  id,
  eventId: null,
  userId: 'updated',
  type: 'CASHOUT_SUCCEEDED',
  message,
  read: false,
  createdAt: new Date(0)
}))

test('N19 bindings are exactly the six legacy file events plus the two cashout events', () => {
  assert.deepEqual([...financeEventBindings], [
    'user.registered',
    'user.kyc_updated',
    'merchant.status_updated',
    'payment.succeeded',
    'payment.failed',
    'payment.expired',
    'funding.cashout_completed',
    'funding.cashout_failed'
  ])
})

test('every bound event type is registered in packages/finvault-events', () => {
  for (const binding of financeEventBindings) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(eventSchemaRegistry, binding),
      `${binding} must be registered before it is bound`
    )
  }
})

test('each binding is either handled or intentionally ignored', () => {
  const ignored = new Set(['user.registered', 'merchant.status_updated'])
  for (const binding of financeEventBindings) {
    if (ignored.has(binding)) {
      assert.equal(handlers[binding], undefined)
    } else {
      assert.equal(typeof handlers[binding], 'function', `${binding} must have a handler`)
    }
  }
  assert.equal(Object.keys(handlers).length, financeEventBindings.length - ignored.size)
})

test('funding.cashout_completed writes one CASHOUT_SUCCEEDED notification with a vi-VN amount', async () => {
  const parsed = parseFinvaultEvent({
    eventId: '00000000-0000-4000-8000-000000000011',
    eventType: 'funding.cashout_completed',
    eventVersion: 1,
    occurredAt: '2026-01-01T00:00:00.000Z',
    data: {
      cashOutId: 'cash-out-1',
      userId: 'user-1',
      amount: '200000',
      walletTransactionId: '00000000-0000-4000-8000-000000000012'
    }
  })
  const transaction = createFakeTransaction()

  await handlers['funding.cashout_completed'](parsed, { tx: transaction.context })

  assert.deepEqual(transaction.rows, [{
    id: 'notification-1',
    eventId: '00000000-0000-4000-8000-000000000011',
    userId: 'user-1',
    type: 'CASHOUT_SUCCEEDED',
    message: 'Lệnh rút 200.000đ của bạn đã thành công.'
  }])
})

test('funding.cashout_failed hides the upstream reason', async () => {
  const parsed = parseFinvaultEvent({
    eventId: '00000000-0000-4000-8000-000000000013',
    eventType: 'funding.cashout_failed',
    eventVersion: 1,
    occurredAt: '2026-01-01T00:00:00.000Z',
    data: {
      cashOutId: 'cash-out-2',
      userId: 'user-2',
      amount: '50000',
      reason: 'internal bank token rejected'
    }
  })
  const transaction = createFakeTransaction()

  await handlers['funding.cashout_failed'](parsed, { tx: transaction.context })

  assert.equal(transaction.rows.length, 1)
  assert.equal(transaction.rows[0].type, 'CASHOUT_FAILED')
  assert.equal(transaction.rows[0].userId, 'user-2')
  assert.equal(transaction.rows[0].message, 'Lệnh rút 50.000đ của bạn không thành công.')
  assert.equal(transaction.rows[0].message.includes('internal bank token rejected'), false)
})

test('malformed cashout payloads fail without creating a notification and without retrying forever', async () => {
  const invalidPayloads: Array<[string, Record<string, unknown>]> = [
    ['funding.cashout_completed', { userId: 'user-1', amount: '-1' }],
    ['funding.cashout_completed', { userId: 'user-1', amount: '12.5' }],
    ['funding.cashout_completed', { userId: 'user-1', amount: 'abc' }],
    ['funding.cashout_completed', { userId: 'user-1' }],
    ['funding.cashout_failed', { amount: '50000', reason: 'x' }]
  ]

  for (const [eventType, data] of invalidPayloads) {
    const transaction = createFakeTransaction()
    await assert.rejects(
      handlers[eventType](event(eventType, data), { tx: transaction.context }),
      (error: unknown) => error instanceof NonRetryableError && error.code === 'INVALID_EVENT_PAYLOAD',
      `${eventType} ${JSON.stringify(data)}`
    )
    assert.deepEqual(transaction.rows, [], `${eventType} must not persist a notification`)
  }
})

test('a cashout event without userId is rejected as non-retryable', async () => {
  const transaction = createFakeTransaction()
  await assert.rejects(
    handlers['funding.cashout_completed'](
      event('funding.cashout_completed', { amount: '50000' }),
      { tx: transaction.context }
    ),
    (error: unknown) => error instanceof NonRetryableError
  )
  assert.deepEqual(transaction.rows, [])
})

test('the inbox processes a repeated cashout eventId exactly once', async () => {
  const inbox = createInMemoryInbox()
  const transaction = createFakeTransaction()
  const cashoutEvent = event('funding.cashout_completed', {
    cashOutId: 'cash-out-3',
    userId: 'user-3',
    amount: '100000'
  })
  const runOnce = () => inbox.runOnce(
    { eventId: cashoutEvent.eventId, eventType: cashoutEvent.eventType, payloadHash: 'hash-1' },
    async () => handlers['funding.cashout_completed'](cashoutEvent, { tx: transaction.context })
  )

  assert.equal((await runOnce()).status, 'processed')
  assert.equal((await runOnce()).status, 'duplicate')
  assert.equal(transaction.rows.length, 1)
})
