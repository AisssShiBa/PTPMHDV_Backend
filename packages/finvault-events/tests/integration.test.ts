import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import amqp, { type ConfirmChannel, type ChannelModel } from 'amqplib'
import { test } from 'node:test'
import {
  createConsumer,
  createInMemoryInbox,
  createPublisher,
  type FinvaultEvent
} from '../src'

const url = process.env.RABBITMQ_URL
if (!url) console.log('NOT RUN: set RABBITMQ_URL to run the RabbitMQ integration test')

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for RabbitMQ integration condition')
    await delay(50)
  }
}

async function waitForQueueMessage(channel: ConfirmChannel, queue: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started <= timeoutMs) {
    const result = await channel.checkQueue(queue)
    if (result.messageCount > 0) return
    await delay(25)
  }
  throw new Error(`Timed out waiting for a message in ${queue}`)
}

function event(eventId: string, data: unknown): FinvaultEvent {
  return {
    eventId,
    eventType: 'payment.expired',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    data
  }
}

test('RabbitMQ publish, idempotency, retry/DLQ, and reconnect', { skip: !url }, async () => {
  const exchange = 'finvault.events'
  const queue = `integration.finvault.events.${process.pid}`
  const applied: string[] = []
  const deadLetters: Array<{ id: string; reason: string; retryCount: number; deaths: unknown }> = []
  const failedId = randomUUID()
  const inbox = createInMemoryInbox()
  const consumer = createConsumer({
    url: url!,
    exchange,
    queue,
    bindings: ['#'],
    inbox,
    maxRetries: 2,
    retryDelaysMs: [80, 120],
    reconnectDelayMs: 250,
    handlers: {
      'payment.expired': async received => {
        applied.push(received.eventId)
        if (received.eventId === failedId) throw new Error('deliberate retry test')
      }
    }
  })
  const publisher = createPublisher({ url: url!, exchange })
  let observerConnection: ChannelModel | undefined
  let observerChannel: ConfirmChannel | undefined

  try {
    await consumer.start()
    observerConnection = await amqp.connect(url!)
    observerChannel = await observerConnection.createConfirmChannel()
    await observerChannel.consume(`${queue}.dlq`, message => {
      if (!message) return
      const body = JSON.parse(message.content.toString()) as { eventId: string }
      const headers = message.properties.headers ?? {}
      deadLetters.push({
        id: body.eventId,
        reason: String(headers['x-dlq-reason']),
        retryCount: Number(headers['x-retry-count']),
        deaths: headers['x-death']
      })
      observerChannel?.ack(message)
    })

    const normalId = randomUUID()
    const normal = event(normalId, { paymentId: 'p-normal', senderId: 'u1' })
    await publisher.publish(normal)
    await waitFor(() => applied.filter(id => id === normalId).length === 1)
    await publisher.publish({ ...normal, occurredAt: new Date(Date.now() + 1000).toISOString() })
    await delay(250)
    assert.equal(applied.filter(id => id === normalId).length, 1, 'redelivery with the same eventId must not re-run handler')

    await publisher.publish(event(normalId, { paymentId: 'p-changed', senderId: 'u1' }))
    await waitFor(() => deadLetters.some(item => item.id === normalId && item.reason === 'EVENT_CONFLICT'))

    await publisher.publish(event(failedId, { paymentId: 'p-fail', senderId: 'u1' }))
    await waitFor(() => deadLetters.some(item => item.id === failedId))
    const retryDlq = deadLetters.find(item => item.id === failedId)!
    assert.equal(retryDlq.reason, 'MAX_RETRIES_EXCEEDED')
    assert.equal(retryDlq.retryCount, 2, 'application retry header must survive TTL dead-lettering')
    assert.ok(Array.isArray(retryDlq.deaths), 'RabbitMQ should attach x-death history for retry TTL')

    const headOfLineQueue = `integration.finvault.events.head-of-line.${process.pid}`
    const headOfLineAttempts = new Map<string, number>()
    let longRetryQueued!: () => void
    const longRetryQueuedPromise = new Promise<void>(resolve => { longRetryQueued = resolve })
    let shortRetryStartedAt = 0
    let shortRetryRedeliveredAt = 0
    const longRetryId = randomUUID()
    const shortRetryId = randomUUID()
    const headOfLineConsumer = createConsumer({
      url: url!,
      exchange,
      queue: headOfLineQueue,
      bindings: ['payment.expired'],
      inbox: createInMemoryInbox(),
      maxRetries: 3,
      retryDelaysMs: [500, 6000],
      handlers: {
        'payment.expired': async received => {
          const attempts = (headOfLineAttempts.get(received.eventId) ?? 0) + 1
          headOfLineAttempts.set(received.eventId, attempts)
          if (received.eventId === longRetryId && attempts <= 2) {
            if (attempts === 2) longRetryQueued()
            throw new Error('deliberate long retry')
          }
          if (received.eventId === shortRetryId) {
            if (attempts === 1) {
              shortRetryStartedAt = Date.now()
              throw new Error('deliberate short retry')
            }
            shortRetryRedeliveredAt = Date.now()
          }
        }
      }
    })
    try {
      await headOfLineConsumer.start()
      await publisher.publish(event(longRetryId, { paymentId: 'p-long-retry', senderId: 'u1' }))
      await longRetryQueuedPromise
      await waitForQueueMessage(observerChannel, `${headOfLineQueue}.retry.6000`)
      await publisher.publish(event(shortRetryId, { paymentId: 'p-short-retry', senderId: 'u1' }))
      await waitFor(() => shortRetryRedeliveredAt > 0, 10000)
      assert.ok(
        shortRetryRedeliveredAt - shortRetryStartedAt < 3000,
        `500ms retry was delayed ${shortRetryRedeliveredAt - shortRetryStartedAt}ms behind the 6000ms retry`
      )
    } finally {
      await headOfLineConsumer.stop()
    }

    const unknown = {
      eventId: randomUUID(),
      eventType: 'unregistered.event',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      data: {}
    }
    observerChannel.publish(exchange, unknown.eventType, Buffer.from(JSON.stringify(unknown)), {
      persistent: true,
      contentType: 'application/json',
      type: unknown.eventType,
      messageId: unknown.eventId
    })
    await waitFor(() => deadLetters.some(item => item.id === unknown.eventId && item.reason === 'UNKNOWN_EVENT_TYPE'))

    const container = process.env.RABBITMQ_TEST_CONTAINER
    if (!container) throw new Error('Set RABBITMQ_TEST_CONTAINER to exercise automatic reconnect via Docker restart')
    execFileSync('docker', ['restart', container], { stdio: 'ignore', timeout: 30000 })
    await delay(1500)
    const afterRestartId = randomUUID()
    const afterRestart = event(afterRestartId, { paymentId: 'p-reconnect', senderId: 'u1' })
    const publishUntilConnected = async () => {
      const until = Date.now() + 20000
      while (Date.now() < until) {
        try {
          await publisher.publish(afterRestart)
          return
        } catch {
          await delay(250)
        }
      }
      throw new Error('Publisher did not reconnect after RabbitMQ restart')
    }
    await publishUntilConnected()
    await waitFor(() => applied.includes(afterRestartId), 20000)
  } finally {
    await publisher.close()
    await consumer.stop()
    await observerChannel?.close().catch(() => {})
    await observerConnection?.close().catch(() => {})
  }
})
