import 'dotenv/config'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createPublisher } from 'finvault-events'
import { env } from '../src/config/env'
import { prisma } from '../src/config/prisma'
import { createFinanceEventsConsumer, financeEventQueue, startFinanceEventsConsumerWithRetry } from '../src/services/financeEventsConsumer'

const localHosts = new Set(['localhost', '127.0.0.1', '::1'])
const databaseUrl = new URL(env.databaseUrl)
const rabbitUrl = env.rabbitmqUrl ? new URL(env.rabbitmqUrl) : undefined
const skipReason = !localHosts.has(databaseUrl.hostname) ||
    !/(?:^|[_-])test$/i.test(databaseUrl.pathname.slice(1))
  ? 'requires a local PostgreSQL test database whose name ends in _test'
  : !rabbitUrl || !localHosts.has(rabbitUrl.hostname) || rabbitUrl.port !== '5674'
    ? 'requires the isolated local RabbitMQ test broker on port 5674'
    : false

async function waitUntil(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(100)
  }
  assert.fail(message)
}

test('finance consumer starts after RabbitMQ is brought up following startup failure', {
  skip: skipReason
}, async () => {
  const composeFile = join(__dirname, '..', 'docker-compose.test.yml')
  const queueName = `${financeEventQueue}.startup.${randomUUID()}`
  const eventId = randomUUID()
  const userId = randomUUID()
  const errors: string[] = []
  let rabbitStopped = false
  const publisher = createPublisher({ url: env.rabbitmqUrl! })
  let supervisor: ReturnType<typeof startFinanceEventsConsumerWithRetry> | undefined

  try {
    execFileSync('docker', [
      'compose', '-f', composeFile, 'stop', 'notification-rabbitmq-test'
    ], { stdio: 'inherit' })
    rabbitStopped = true
    supervisor = startFinanceEventsConsumerWithRetry({
      url: env.rabbitmqUrl!,
      createConsumer: url => createFinanceEventsConsumer(url, queueName),
      logError: message => errors.push(message)
    })
    await waitUntil(async () => errors.length > 0, 'Consumer did not report the initial RabbitMQ failure')

    execFileSync('docker', [
      'compose', '-f', composeFile, 'start', 'notification-rabbitmq-test'
    ], { stdio: 'inherit' })
    rabbitStopped = false

    const started = await Promise.race([
      supervisor.whenStarted,
      delay(60_000).then(() => { throw new Error('Consumer did not start after RabbitMQ recovery') })
    ])
    assert.equal(started, true)

    await publisher.publish({
      eventId,
      eventType: 'payment.expired',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      data: { paymentId: randomUUID(), senderId: userId }
    })
    await waitUntil(
      async () => (await prisma.notification.count({ where: { eventId } })) === 1,
      'Notification was not persisted after consumer startup recovered'
    )

    assert.equal(await prisma.notificationInbox.count({ where: { eventId } }), 1)
    console.log(`Startup retry PASS: initial failures=${errors.length}; event=${eventId} persisted`)
  } finally {
    await supervisor?.stop()
    await publisher.close()
    if (rabbitStopped) {
      execFileSync('docker', [
        'compose', '-f', composeFile, 'start', 'notification-rabbitmq-test'
      ], { stdio: 'inherit' })
    }
    await prisma.notification.deleteMany({ where: { eventId } })
    await prisma.notificationInbox.deleteMany({ where: { eventId } })
    await prisma.$disconnect()
  }
})
