import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import amqp, { type ChannelModel, type ConfirmChannel, type ConsumeMessage, type Options } from 'amqplib'
import {
  createConsumer,
  createInMemoryInbox,
  createPublisher,
  type FinvaultEvent
} from '../src'
import { processConsumerMessage } from '../src/consumer'

const url = process.env.RABBITMQ_URL
const queue = `demo.finvault.events.${process.pid}`
const tierChanges: string[] = []
const inbox = createInMemoryInbox()
const normalId = randomUUID()
const failingId = randomUUID()

class FakeConfirmChannel extends EventEmitter {
  published: Array<{ key: string; options: Options.Publish }> = []
  acked = 0
  nacked = 0

  publish(
    _exchange: string,
    key: string,
    _content: Buffer,
    options: Options.Publish,
    callback?: (error: Error | null) => void
  ): boolean {
    this.published.push({ key, options })
    queueMicrotask(() => callback?.(null))
    return true
  }

  ack(): void { this.acked += 1 }
  nack(): void { this.nacked += 1 }
}

function kycEvent(eventId: string): FinvaultEvent {
  return {
    eventId,
    eventType: 'user.kyc_updated',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    data: { authUserId: 'auth-user-demo', kycTier: 2, previousTier: 1 }
  }
}

async function runFake(): Promise<void> {
  console.log('MODE: FAKE CHANNEL (no RabbitMQ connection)')
  const channel = new FakeConfirmChannel()
  const options = {
    url: 'amqp://fake',
    queue: 'demo.finvault.events.fake',
    bindings: ['user.kyc_updated'],
    inbox,
    maxRetries: 2,
    retryDelaysMs: [10, 20],
    handlers: {
      'user.kyc_updated': async (event: FinvaultEvent) => {
        if (event.eventId === failingId) throw new Error('intentional demo failure')
        tierChanges.push(event.eventId)
      }
    }
  }
  const deliver = async (message: FinvaultEvent, headers: Record<string, unknown> = {}) => {
    const retryCount = Number(headers['x-retry-count'] ?? 0)
    const routingKey = retryCount > 0 ? options.queue : message.eventType
    await processConsumerMessage(channel as unknown as ConfirmChannel, {
      content: Buffer.from(JSON.stringify(message)),
      fields: { exchange: 'finvault.events', routingKey },
      properties: { messageId: message.eventId, type: message.eventType, headers }
    } as unknown as ConsumeMessage, options)
  }

  console.log('publish user.kyc_updated v1')
  await deliver(kycEvent(normalId))
  await deliver(kycEvent(normalId))
  console.log(`duplicate delivered; mutation count=${tierChanges.length}`)

  const failedEvent = kycEvent(failingId)
  let currentHeaders: Record<string, unknown> = {}
  await deliver(failedEvent)
  while (channel.published.at(-1)?.key === `${options.queue}.retry`) {
    currentHeaders = channel.published.at(-1)!.options.headers as Record<string, unknown>
    console.log(`retry ${String(currentHeaders['x-retry-count'])}`)
    await deliver(failedEvent, currentHeaders)
  }
  const dlq = channel.published.at(-1)
  console.log(`DLQ ${failingId}: ${String(dlq?.options.headers?.['x-dlq-reason'])}`)
}

async function runRabbit(): Promise<void> {
  const publisher = createPublisher({ url: url! })
  const consumer = createConsumer({
    url: url!,
    queue,
    bindings: ['user.kyc_updated'],
    inbox,
    maxRetries: 2,
    retryDelaysMs: [250, 500],
    handlers: {
      'user.kyc_updated': async event => {
        if (event.eventId === failingId) throw new Error('intentional demo failure')
        tierChanges.push(event.eventId)
        firstMutationDone()
        console.log(`mutation applied for ${event.eventId}`)
      }
    }
  })
  let resolveFirstMutation!: () => void
  const firstMutation = new Promise<void>(resolve => { resolveFirstMutation = resolve })
  function firstMutationDone(): void { resolveFirstMutation() }
  let resolveDeadLetter!: () => void
  const deadLetterObserved = new Promise<void>(resolve => { resolveDeadLetter = resolve })
  let observerConnection: ChannelModel | undefined
  let observerChannel: ConfirmChannel | undefined

  try {
    await consumer.start()
    observerConnection = await amqp.connect(url!)
    observerChannel = await observerConnection.createConfirmChannel()
    await observerChannel.consume(`${queue}.dlq`, message => {
      if (!message) return
      console.log(`DLQ received ${message.properties.messageId}: ${String(message.properties.headers?.['x-dlq-reason'])}`)
      observerChannel?.ack(message)
      resolveDeadLetter()
    })
    await publisher.publish(kycEvent(normalId))
    await Promise.race([firstMutation, delay(5000).then(() => { throw new Error('Timed out waiting for first KYC mutation') })])
    await publisher.publish(kycEvent(normalId))
    console.log('same eventId published again; inbox suppresses the second mutation')
    await publisher.publish({ ...kycEvent(failingId), data: { authUserId: 'auth-user-demo', kycTier: 1, previousTier: 0 } })
    await Promise.race([deadLetterObserved, delay(5000).then(() => { throw new Error('Timed out waiting for DLQ delivery') })])
    console.log(`mutation count=${tierChanges.length}`)
  } finally {
    await publisher.close()
    await consumer.stop()
    await observerChannel?.close().catch(() => {})
    await observerConnection?.close().catch(() => {})
  }
}

async function main(): Promise<void> {
  if (url) await runRabbit()
  else await runFake()
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
