import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EventConsumer } from 'finvault-events'
import { startFinanceEventsConsumerWithRetry } from '../src/services/financeEventsConsumer'

const fakeConsumer = (start: () => Promise<void>): EventConsumer => ({
  start,
  stop: async () => {}
})

test('finance consumer retries an initial broker connection failure and starts once available', async () => {
  let createCount = 0
  const delays: number[] = []
  const supervisor = startFinanceEventsConsumerWithRetry({
    url: 'amqp://test-broker',
    createConsumer: () => {
      createCount += 1
      return createCount === 1
        ? fakeConsumer(async () => { throw new Error('broker unavailable') })
        : fakeConsumer(async () => {})
    },
    sleep: async milliseconds => { delays.push(milliseconds) },
    logError: () => {}
  })

  assert.equal(await supervisor.whenStarted, true)
  assert.equal(createCount, 2)
  assert.deepEqual(delays, [2000])
  await supervisor.stop()
  assert.equal(createCount, 2)
})

test('finance consumer does not retry after stop during backoff', async () => {
  let createCount = 0
  let releaseSleep!: () => void
  const supervisor = startFinanceEventsConsumerWithRetry({
    url: 'amqp://test-broker',
    createConsumer: () => {
      createCount += 1
      return fakeConsumer(async () => { throw new Error('broker unavailable') })
    },
    sleep: (_milliseconds, signal) => new Promise<void>(resolve => {
      releaseSleep = resolve
      signal.addEventListener('abort', () => resolve(), { once: true })
    }),
    logError: () => {}
  })

  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(createCount, 1)
  await supervisor.stop()
  releaseSleep()
  assert.equal(await supervisor.whenStarted, false)
  assert.equal(createCount, 1)
})
