import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import amqp from 'amqplib'
import { after, test } from 'node:test'
import { io as createSocketClient, type Socket } from 'socket.io-client'
import { createPublisher, eventPayloadHash } from 'finvault-events'
import { createTestGatewayToken } from 'finvault-internal-auth'
import { prisma } from '../src/config/prisma'
import { env } from '../src/config/env'
import { createFinanceEventHandlers, createFinanceEventsConsumer, financeEventBindings } from '../src/services/financeEventsConsumer'
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
    socket.once('connect_error', error => { socket.close(); reject(error) })
    socket.connect()
  })
}

test('refund events have an explicit queue binding and persistence handler', () => {
  assert.equal(financeEventBindings.filter(type => type === 'payment.refunded').length, 1)
  const handlers = createFinanceEventHandlers(
    { getFullName: async () => assert.fail('registration must not query users') },
    async () => assert.fail('registration must not update notifications')
  )
  assert.equal(typeof handlers['payment.refunded'], 'function')
})

test('KYC review events have an explicit queue binding and persistence handler', () => {
  assert.equal(financeEventBindings.filter(type => type === 'user.kyc_reviewed').length, 1)
  const handlers = createFinanceEventHandlers(
    { getFullName: async () => assert.fail('KYC must not query users') },
    async () => assert.fail('KYC must not enrich notifications')
  )
  assert.equal(typeof handlers['user.kyc_reviewed'], 'function')
})

function refundEvent(eventId: string, userId: string, destinationUserId: string) {
  return {
    eventId, eventType: 'payment.refunded', eventVersion: 1, occurredAt: new Date().toISOString(),
    data: {
      paymentId: randomUUID(), userId, destinationUserId, amount: '50000.00', status: 'REFUNDED',
      referenceId: `refund-${eventId}`, walletTransactionId: randomUUID(), refundedAt: new Date().toISOString()
    }
  }
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
  const refundEventId = randomUUID()
  const refundRollbackEventId = randomUUID()
  const kycApprovedId = randomUUID()
  const kycRejectedId = randomUUID()
  const kycRollbackId = randomUUID()
  const kycIds: string[] = [kycApprovedId, kycRejectedId, kycRollbackId]
  const eventIds = [eventId, ignoredEventId, legacyKycEventId, rollbackEventId, refundEventId, refundRollbackEventId, ...kycIds]
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
    if (rabbitChannel) {
      await Promise.allSettled([queue, `${queue}.dlq`, ...[1000, 5000, 30000].map(ms => `${queue}.retry.${ms}`)]
        .map(name => rabbitChannel!.deleteQueue(name)))
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

  const refundSenderEvents: string[] = []
  const refundReceiverEvents: string[] = []
  senderSocket.on('notification:new', (notification: { eventId: string }) => {
    if (notification.eventId === refundEventId || notification.eventId === refundRollbackEventId) refundSenderEvents.push(notification.eventId)
  })
  receiverSocket.on('notification:new', (notification: { eventId: string }) => {
    if (notification.eventId === refundEventId || notification.eventId === refundRollbackEventId) refundReceiverEvents.push(notification.eventId)
  })
  const refund = refundEvent(refundEventId, userSender, userReceiver)

  await t.test('refund reaches only the refunded user once; replay is deduplicated and conflicts are dead-lettered', async () => {
    await publisher.publish(refund)
    const notifications = await waitFor(
      () => prisma.notification.findMany({ where: { eventId: refundEventId } }),
      rows => rows.length === 1, 'one refund notification'
    )
    assert.equal(notifications[0].userId, userSender)
    assert.equal(notifications[0].type, 'PAYMENT_REFUNDED')
    assert.equal(notifications[0].message, 'Bạn được hoàn 50.000đ vào ví.')
    await waitFor(async () => refundSenderEvents.length, count => count === 1, 'refund Socket.IO delivery')
    await Promise.all([publisher.publish(refund), publisher.publish(refund)])
    await publisher.publish({ ...refund, data: { ...refund.data, amount: '51000.00' } })
    const conflict = await waitFor(async () => {
      const message = await rabbitChannel!.get(`${queue}.dlq`, { noAck: false })
      if (!message) return undefined
      const body: { eventId?: string } = JSON.parse(message.content.toString())
      if (body.eventId === refundEventId && message.properties.headers?.['x-dlq-reason'] === 'EVENT_CONFLICT') return message
      rabbitChannel!.nack(message, false, true)
      return undefined
    }, message => message !== undefined, 'refund conflict in DLQ')
    rabbitChannel!.ack(conflict!)
    assert.equal(await prisma.notification.count({ where: { eventId: refundEventId } }), 1)
    assert.equal(await prisma.notificationInbox.count({ where: { eventId: refundEventId } }), 1)
  })

  await t.test('refund rollback emits nothing and a later broker delivery can persist the same event', async () => {
    const retry = refundEvent(refundRollbackEventId, userSender, userReceiver)
    let afterCommitCalls = 0
    await assert.rejects(inbox.runOnce({
      eventId: retry.eventId, eventType: retry.eventType, payloadHash: eventPayloadHash(retry)
    }, async tx => {
      const context = tx as FinanceTransactionContext
      context.afterCommit(() => { afterCommitCalls++ })
      await context.prisma.notification.create({ data: {
        eventId: retry.eventId, userId: userSender, type: 'PAYMENT_REFUNDED', message: 'Must roll back'
      } })
      throw new Error('force refund rollback')
    }), /force refund rollback/)
    assert.equal(afterCommitCalls, 0)
    assert.equal(await prisma.notification.count({ where: { eventId: retry.eventId } }), 0)
    assert.equal(await prisma.notificationInbox.count({ where: { eventId: retry.eventId } }), 0)
    assert.equal(refundSenderEvents.includes(retry.eventId), false)
    await publisher.publish(retry)
    await waitFor(() => prisma.notification.count({ where: { eventId: retry.eventId } }),
      count => count === 1, 'refund notification after rollback recovery')
    await waitFor(async () => refundSenderEvents.filter(id => id === retry.eventId).length,
      count => count === 1, 'refund socket after rollback recovery')
  })

  const kycOwnerEvents: string[] = []
  const kycOtherEvents: string[] = []
  senderSocket.on('notification:new', (notification: { eventId: string }) => {
    if (kycIds.includes(notification.eventId)) kycOwnerEvents.push(notification.eventId)
  })
  receiverSocket.on('notification:new', (notification: { eventId: string }) => {
    if (kycIds.includes(notification.eventId)) kycOtherEvents.push(notification.eventId)
  })
  const approved = {
    eventId: kycApprovedId, eventType: 'user.kyc_reviewed', eventVersion: 1,
    occurredAt: new Date().toISOString(), data: { authUserId: userSender, status: 'APPROVED' }
  }
  const rejected = {
    ...approved, eventId: kycRejectedId,
    data: { authUserId: userSender, status: 'REJECTED', reason: 'Blurry\nback image' }
  }
  await t.test('KYC decisions reach only their owner; duplicate reviews create no extra notification', async () => {
    await publisher.publish(approved)
    await publisher.publish(rejected)
    const rows = await waitFor(() => prisma.notification.findMany({ where: { eventId: { in: [kycApprovedId, kycRejectedId] } } }),
      rows => rows.length === 2, 'approval and rejection notifications')
    assert.ok(rows.every(row => row.userId === userSender))
    assert.equal(rows.find(row => row.eventId === kycApprovedId)?.type, 'KYC_APPROVED')
    const rejection = rows.find(row => row.eventId === kycRejectedId)!
    assert.equal(rejection.type, 'KYC_REJECTED')
    assert.ok(rejection.message.includes('Blurry back image'))
    assert.equal(rejection.message.includes('\n'), false)
    await waitFor(async () => kycOwnerEvents.length, count => count === 2, 'KYC sockets')
    await Promise.all([publisher.publish(approved), publisher.publish(rejected), publisher.publish(rejected)])
    await publisher.publish({ ...rejected, data: { ...rejected.data, reason: 'Changed reason' } })
    const conflict = await waitFor(async () => {
      const message = await rabbitChannel!.get(`${queue}.dlq`, { noAck: false })
      if (!message) return undefined
      if (JSON.parse(message.content.toString()).eventId === kycRejectedId &&
          message.properties.headers?.['x-dlq-reason'] === 'EVENT_CONFLICT') return message
      rabbitChannel!.nack(message, false, true)
      return undefined
    }, message => message !== undefined, 'KYC conflict in DLQ')
    rabbitChannel!.ack(conflict!)
    assert.equal(await prisma.notificationInbox.count({ where: { eventId: { in: [kycApprovedId, kycRejectedId] } } }), 2)
    assert.equal(await prisma.notification.count({ where: { eventId: { in: [kycApprovedId, kycRejectedId] } } }), 2)
  })
  await t.test('KYC inbox rollback creates no notification/socket and permits a later delivery', async () => {
    const event = { ...rejected, eventId: kycRollbackId }
    const handlers = createFinanceEventHandlers(
      { getFullName: async () => assert.fail('KYC must not query users') },
      async () => assert.fail('KYC must not enrich notifications')
    )
    await assert.rejects(inbox.runOnce({
      eventId: event.eventId, eventType: event.eventType, payloadHash: eventPayloadHash(event)
    }, async tx => {
      await handlers[event.eventType](event, { tx })
      throw new Error('force KYC rollback')
    }), /force KYC rollback/)
    assert.equal(await prisma.notification.count({ where: { eventId: kycRollbackId } }), 0)
    assert.equal(await prisma.notificationInbox.count({ where: { eventId: kycRollbackId } }), 0)
    assert.equal(kycOwnerEvents.includes(kycRollbackId), false)
    await publisher.publish(event)
    await waitFor(async () => kycOwnerEvents.filter(id => id === kycRollbackId).length,
      count => count === 1, 'KYC socket after rollback recovery')
  })

  // Drain in-flight handlers before asserting the final delivery counts.
  await consumer.stop()
  await delay(100)
  assert.equal(refundSenderEvents.filter(id => id === refundEventId).length, 1)
  assert.equal(refundSenderEvents.filter(id => id === refundRollbackEventId).length, 1)
  assert.equal(refundReceiverEvents.length, 0)
  assert.equal(kycOtherEvents.length, 0)
  for (const id of kycIds) assert.equal(kycOwnerEvents.filter(eventId => eventId === id).length, 1)
})

after(async () => {
  await prisma.$disconnect()
})
