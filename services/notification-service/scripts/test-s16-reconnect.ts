import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import amqp from 'amqplib'
import { createPublisher } from 'finvault-events'
import { env } from '../src/config/env'
import { prisma } from '../src/config/prisma'
import { createFinanceEventsConsumer, financeEventQueue } from '../src/services/financeEventsConsumer'

const isLocal = new Set(['localhost', '127.0.0.1', '::1'])

async function waitForConsumer(queueName: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    let connection: Awaited<ReturnType<typeof amqp.connect>> | undefined
    let channel: Awaited<ReturnType<Awaited<ReturnType<typeof amqp.connect>>['createChannel']>> | undefined
    try {
      connection = await amqp.connect(env.rabbitmqUrl!)
      channel = await connection.createChannel()
      const queue = await channel.checkQueue(queueName)
      if (queue.consumerCount > 0) return
    } catch (error) {
      lastError = error
    } finally {
      await channel?.close().catch(() => {})
      await connection?.close().catch(() => {})
    }
    await delay(500)
  }
  throw new Error(`Timed out waiting for the consumer to reconnect: ${String(lastError ?? 'no consumer')}`)
}

async function waitForNotification(eventId: string): Promise<number> {
  const deadline = Date.now() + 15_000
  let count = 0
  while (Date.now() < deadline) {
    count = await prisma.notification.count({ where: { eventId } })
    if (count > 0) return count
    await delay(100)
  }
  return count
}

async function main(): Promise<void> {
  if (!env.rabbitmqUrl) throw new Error('RABBITMQ_URL is required')
  const database = new URL(env.databaseUrl)
  const broker = new URL(env.rabbitmqUrl)
  if (!isLocal.has(database.hostname) || !/(?:^|[_-])test$/i.test(database.pathname.slice(1))) {
    throw new Error('S16 requires a local dedicated test database whose name ends in _test')
  }
  if (!isLocal.has(broker.hostname) || broker.port !== '5674') {
    throw new Error('S16 requires the isolated local RabbitMQ test broker on port 5674')
  }

  const eventId = randomUUID()
  const userId = randomUUID()
  const queueName = `${financeEventQueue}.s16.${randomUUID()}`
  const consumer = createFinanceEventsConsumer(env.rabbitmqUrl, queueName)
  let publisher: ReturnType<typeof createPublisher> | undefined
  try {
    await consumer.start()
    await waitForConsumer(queueName, 10_000)

    execFileSync('docker', [
      'compose',
      '-f',
      join(__dirname, '..', 'docker-compose.test.yml'),
      'restart',
      'notification-rabbitmq-test'
    ], { stdio: 'inherit' })
    console.log('RabbitMQ test container restarted while the finance consumer was running')

    await waitForConsumer(queueName, 45_000)
    console.log('Finance consumer reconnected and restored its queue consumer')

    publisher = createPublisher({ url: env.rabbitmqUrl })
    const event = {
      eventId,
      eventType: 'payment.expired',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      data: { paymentId: randomUUID(), senderId: userId }
    }
    await publisher.publish(event)
    assert.equal(await waitForNotification(eventId), 1)
    await publisher.publish(event)
    await delay(300)
    assert.equal(await prisma.notification.count({ where: { eventId } }), 1)
    assert.equal(await prisma.notificationInbox.count({ where: { eventId } }), 1)
    console.log('S16 PASS: notification arrived once after RabbitMQ recovery; duplicate publish remained idempotent')
  } finally {
    await consumer.stop()
    await publisher?.close()
    await prisma.notification.deleteMany({ where: { eventId } })
    await prisma.notificationInbox.deleteMany({ where: { eventId } })
    await prisma.$disconnect()
  }
}

void main().catch((error: unknown) => {
  console.error('S16 reconnect test failed:', error)
  process.exitCode = 1
})
