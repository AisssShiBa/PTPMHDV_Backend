import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import amqp from 'amqplib'
import { after, test } from 'node:test'
import { io as createSocketClient, type Socket } from 'socket.io-client'
import { createPublisher } from 'finvault-events'
import { createTestGatewayToken } from 'finvault-internal-auth'
import { prisma } from '../src/config/prisma'
import { env } from '../src/config/env'
import { createFinanceEventsConsumer } from '../src/services/financeEventsConsumer'
import { createFinanceEventsInbox, type FinanceTransactionContext } from '../src/services/financeEventsInbox'
import { createSocketServer } from '../src/socket'

const localHostNames = new Set(['localhost', '127.0.0.1', '::1'])
const databaseUrl = new URL(env.databaseUrl)
const rabbitUrl = env.rabbitmqUrl ? new URL(env.rabbitmqUrl) : undefined
const hasDedicatedLocalDatabase =
  localHostNames.has(databaseUrl.hostname) && /(?:^|[_-])test$/i.test(databaseUrl.pathname.slice(1))
const hasLocalRabbitMq = rabbitUrl !== undefined && localHostNames.has(rabbitUrl.hostname)
const skipReason = !hasDedicatedLocalDatabase
  ? 'requires a dedicated local PostgreSQL database whose name ends in _test'
  : !hasLocalRabbitMq
    ? 'requires a local RabbitMQ test broker configured with RABBITMQ_URL'
    : false

const delay = (milliseconds: number) =>
  new Promise<void>(resolve => setTimeout(resolve, milliseconds))

async function waitFor<T>(
  read: () => Promise<T>,
  isReady: (value: T) => boolean,
  description: string,
  timeoutMs = 8000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (!isReady(value) && Date.now() < deadline) {
    await delay(50)
    value = await read()
  }
  assert.ok(isReady(value), `Timed out waiting for ${description}`)
  return value
}

function openSocket(url: string, userId: string): Promise<Socket> {
  const socket = createSocketClient(url, {
    auth: { token: createTestGatewayToken(userId) },
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    timeout: 2000,
    transports: ['websocket']
  })
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket))
    socket.once('connect_error', reject)
    socket.connect()
  })
}

test('FinVault events persist transactionally, deduplicate, and emit only once over Socket.IO', {
  skip: skipReason
}, async t => {
  const queue = `notification.finvault.events.test.${randomUUID()}`
  const userSender = randomUUID()
  const userReceiver = randomUUID()
  const eventId = randomUUID()
  const ignoredEventId = randomUUID()
  const legacyKycEventId = randomUUID()
  const rollbackEventId = randomUUID()
  const eventIds = [eventId, ignoredEventId, legacyKycEventId, rollbackEventId]
  const clients: Socket[] = []
  const httpServer = http.createServer()
  const socketServer = createSocketServer(httpServer)
  const consumer = createFinanceEventsConsumer(env.rabbitmqUrl!, queue)
  const publisher = createPublisher({ url: env.rabbitmqUrl! })
  let rabbitConnection: Awaited<ReturnType<typeof amqp.connect>> | undefined
  let rabbitChannel: Awaited<ReturnType<Awaited<ReturnType<typeof amqp.connect>>['createChannel']>> | undefined

  t.after(async () => {
    for (const client of clients) client.close()
    await consumer.stop()
    await publisher.close()
    await new Promise<void>(resolve => socketServer.close(() => resolve()))
    if (httpServer.listening) {
      await new Promise<void>(resolve => httpServer.close(() => resolve()))
    }
    await rabbitChannel?.close()
    await rabbitConnection?.close()
    await prisma.notification.deleteMany({ where: { eventId: { in: eventIds } } })
    await prisma.notificationInbox.deleteMany({ where: { eventId: { in: eventIds } } })
  })

  await consumer.start()
  await new Promise<void>((resolve, reject) => {
    httpServer.once('listening', resolve)
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1')
  })
  const address = httpServer.address()
  assert.ok(address && typeof address !== 'string')
  const socketUrl = `http://127.0.0.1:${address.port}`
  const senderSocket = await openSocket(socketUrl, userSender)
  const receiverSocket = await openSocket(socketUrl, userReceiver)
  clients.push(senderSocket, receiverSocket)

  let senderEmissions = 0
  let receiverEmissions = 0
  senderSocket.on('notification:new', () => { senderEmissions += 1 })
  receiverSocket.on('notification:new', () => { receiverEmissions += 1 })

  const paymentEvent = {
    eventId,
    eventType: 'payment.succeeded',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    data: {
      paymentId: randomUUID(),
      senderId: userSender,
      receiverId: userReceiver,
      amount: '50000'
    }
  }
  await publisher.publish(paymentEvent)
  await waitFor(
    () => prisma.notification.findMany({ where: { eventId }, orderBy: { userId: 'asc' } }),
    rows => rows.length === 2,
    'two payment notifications'
  )
  await waitFor(
    async () => [senderEmissions, receiverEmissions],
    counts => counts[0] === 1 && counts[1] === 1,
    'one Socket.IO emission per recipient'
  )

  await publisher.publish(paymentEvent)
  await delay(300)
  assert.equal(await prisma.notification.count({ where: { eventId } }), 2)
  assert.equal(await prisma.notificationInbox.count({ where: { eventId } }), 1)
  assert.equal(senderEmissions, 1)
  assert.equal(receiverEmissions, 1)

  await publisher.publish({
    ...paymentEvent,
    data: { ...paymentEvent.data, amount: '51000' }
  })
  rabbitConnection = await amqp.connect(env.rabbitmqUrl!)
  rabbitChannel = await rabbitConnection.createChannel()
  const conflict = await waitFor(
    async () => {
      const message = await rabbitChannel!.get(`${queue}.dlq`, { noAck: false })
      if (!message) return undefined
      if (message.properties.headers?.['x-dlq-reason'] === 'EVENT_CONFLICT') return message
      rabbitChannel!.nack(message, false, true)
      return undefined
    },
    message => message !== undefined,
    'EVENT_CONFLICT in the dead-letter queue'
  )
  assert.equal(conflict?.properties.headers?.['x-dlq-reason'], 'EVENT_CONFLICT')
  rabbitChannel.ack(conflict!)

  await publisher.publish({
    eventId: ignoredEventId,
    eventType: 'user.registered',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    data: { authUserId: randomUUID(), email: 'ignored@example.test' }
  })
  await delay(300)
  assert.equal(await prisma.notificationInbox.count({ where: { eventId: ignoredEventId } }), 0)
  assert.equal(await prisma.notification.count({ where: { eventId: ignoredEventId } }), 0)
  assert.equal((await rabbitChannel.checkQueue(queue)).messageCount, 0)

  const legacyKyc = {
    eventId: legacyKycEventId,
    eventType: 'user.kyc_updated',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    data: { authUserId: userSender, kycTier: 2 }
  }
  await rabbitChannel.publish(
    'finvault.events',
    'user.kyc_updated',
    Buffer.from(JSON.stringify(legacyKyc)),
    { persistent: true, contentType: 'application/json', type: 'user.kyc_updated', messageId: legacyKycEventId }
  )
  const legacyNotification = await waitFor(
    () => prisma.notification.findFirst({ where: { eventId: legacyKycEventId } }),
    notification => notification !== null,
    'legacy KYC notification'
  )
  assert.equal(legacyNotification?.message, 'Cấp xác thực của bạn đã được cập nhật lên cấp 2.')

  const inbox = createFinanceEventsInbox(prisma)
  await assert.rejects(inbox.runOnce(
    { eventId: rollbackEventId, eventType: 'payment.succeeded', payloadHash: 'rollback-hash' },
    async tx => {
      const context = tx as FinanceTransactionContext
      await context.prisma.notification.create({
        data: {
          eventId: rollbackEventId,
          userId: userSender,
          type: 'PAYMENT_SUCCESS',
          message: 'Must be rolled back'
        }
      })
      throw new Error('force transaction rollback')
    }
  ), /force transaction rollback/)
  assert.equal(await prisma.notificationInbox.count({ where: { eventId: rollbackEventId } }), 0)
  assert.equal(await prisma.notification.count({ where: { eventId: rollbackEventId } }), 0)
})

after(async () => {
  await prisma.$disconnect()
})
