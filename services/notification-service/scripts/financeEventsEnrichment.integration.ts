import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import amqp from 'amqplib'
import { io as createSocketClient, type Socket } from 'socket.io-client'
import { createPublisher } from 'finvault-events'
import { createTestGatewayToken } from 'finvault-internal-auth'
import { env } from '../src/config/env'
import { prisma } from '../src/config/prisma'
import { createFinanceEventsConsumer } from '../src/services/financeEventsConsumer'
import { createUserLookupClient } from '../src/services/userLookup'
import { createSocketServer } from '../src/socket'

const localHosts = new Set(['localhost', '127.0.0.1', '::1'])
const databaseUrl = new URL(env.databaseUrl)
const rabbitUrl = env.rabbitmqUrl ? new URL(env.rabbitmqUrl) : undefined
const skipReason = !localHosts.has(databaseUrl.hostname) ||
    !/(?:^|[_-])test$/i.test(databaseUrl.pathname.slice(1))
  ? 'requires a local PostgreSQL test database whose name ends in _test'
  : !rabbitUrl || !localHosts.has(rabbitUrl.hostname)
    ? 'requires a local RabbitMQ test broker configured with RABBITMQ_URL'
    : false

type SocketNotification = {
  eventId: string
  userId: string
  message: string
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(50)
  }
  assert.fail(message)
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Integration test server did not bind a TCP port'))
        return
      }
      resolve(address.port)
    })
  })
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(error => error ? reject(error) : resolve())
  })
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
    socket.once('connect_error', error => {
      socket.close()
      reject(error)
    })
    socket.connect()
  })
}

function waitForNotification(socket: Socket, eventId: string): Promise<SocketNotification> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('notification:new', listener)
      reject(new Error(`Timed out waiting for notification ${eventId}`))
    }, 10_000)
    const listener = (notification: SocketNotification) => {
      if (notification.eventId !== eventId) return
      clearTimeout(timeout)
      socket.off('notification:new', listener)
      resolve(notification)
    }
    socket.on('notification:new', listener)
  })
}

test('finance payment enrichment is post-commit, private, idempotent, and degrades safely', {
  skip: skipReason
}, async t => {
  const queue = `notification.finvault.events.enrichment.${randomUUID()}`
  const eventIds = new Set<string>()
  const eventForUser = new Map<string, string>()
  const names = new Map<string, string>()
  const failedUsers = new Set<string>()
  const requestHeaders: string[] = []
  const lookupObservedCommittedGeneric = new Set<string>()
  const clients: Socket[] = []
  const logs: string[] = []
  const originalError = console.error
  const originalWarn = console.warn
  const lookupServer = http.createServer((request, response) => {
    void (async () => {
      const userId = decodeURIComponent(request.url?.split('/').filter(Boolean).at(-1) ?? '')
      const internalKey = request.headers['x-internal-key']
      requestHeaders.push(Array.isArray(internalKey) ? internalKey.join(',') : internalKey ?? '')
      const eventId = eventForUser.get(userId)
      if (eventId) {
        const rows = await prisma.notification.findMany({ where: { eventId } })
        if (rows.length === 2 && rows.every(row =>
          row.message === 'Bạn đã chuyển 50.000đ cho một người dùng.' ||
          row.message === 'Bạn nhận 50.000đ từ một người dùng.'
        )) {
          lookupObservedCommittedGeneric.add(eventId)
        }
      }
      if (failedUsers.has(userId)) {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'internal service details not for logging' }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        success: true,
        data: { fullName: names.get(userId) ?? null }
      }))
    })().catch(error => {
      response.writeHead(500)
      response.end()
      originalError('[test lookup server] request failed', error)
    })
  })
  const lookupPort = await listen(lookupServer)
  const socketHttp = http.createServer()
  const actualSocketServer = createSocketServer(socketHttp)
  const publisher = createPublisher({ url: env.rabbitmqUrl! })
  const queueConsumer = createFinanceEventsConsumer(env.rabbitmqUrl!, queue, {
    userLookup: createUserLookupClient({
      baseUrl: `http://127.0.0.1:${lookupPort}/api/users/by-auth`,
      internalKey: env.internalKey,
      timeoutMs: 150,
      fetchImpl: fetch,
      logFailure: (code, userId) => logs.push(`lookup:${code}:${userId}`)
    }),
    updateNotification: async (id, message) => {
      if (failUpdates) throw new Error('simulated notification update failure')
      return prisma.notification.update({ where: { id }, data: { message } })
    }
  })
  let failUpdates = false
  let rabbitConnection: Awaited<ReturnType<typeof amqp.connect>> | undefined
  let rabbitChannel: Awaited<ReturnType<Awaited<ReturnType<typeof amqp.connect>>['createChannel']>> | undefined
  const captureLog = (...args: unknown[]) => {
    logs.push(args.map(value => typeof value === 'string'
      ? value
      : JSON.stringify(value, (_key, nested: unknown) =>
        nested instanceof Error ? { message: nested.message } : nested) ?? String(value)
    ).join(' '))
  }
  console.error = captureLog
  console.warn = captureLog

  const issue = async (
    senderId: string,
    receiverId: string,
    eventId: string
  ): Promise<{ senderSocket: Socket; receiverSocket: Socket }> => {
    const senderSocket = await openSocket(socketUrl, senderId)
    const receiverSocket = await openSocket(socketUrl, receiverId)
    clients.push(senderSocket, receiverSocket)
    eventForUser.set(senderId, eventId)
    eventForUser.set(receiverId, eventId)
    return { senderSocket, receiverSocket }
  }

  let socketUrl = ''
  await new Promise<void>((resolve, reject) => {
    socketHttp.once('error', reject)
    socketHttp.listen(0, '127.0.0.1', () => {
      const address = socketHttp.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Socket test server did not bind a port'))
        return
      }
      socketUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })
  t.after(async () => {
    for (const client of clients) client.close()
    await queueConsumer.stop()
    await publisher.close()
    await new Promise<void>(resolve => actualSocketServer.close(() => resolve()))
    await closeServer(socketHttp)
    await closeServer(lookupServer)
    if (rabbitChannel) await rabbitChannel.close()
    if (rabbitConnection) await rabbitConnection.close()
    if (eventIds.size > 0) {
      const ids = [...eventIds]
      await prisma.notification.deleteMany({ where: { eventId: { in: ids } } })
      await prisma.notificationInbox.deleteMany({ where: { eventId: { in: ids } } })
    }
    console.error = originalError
    console.warn = originalWarn
    await prisma.$disconnect()
  })

  await queueConsumer.start()
  rabbitConnection = await amqp.connect(env.rabbitmqUrl!)
  rabbitChannel = await rabbitConnection.createChannel()

  const successEventId = randomUUID()
  const successSender = randomUUID()
  const successReceiver = randomUUID()
  eventIds.add(successEventId)
  names.set(successSender, 'Nguyễn Văn An')
  names.set(successReceiver, 'Trần Thị Bình')
  const successSockets = await issue(successSender, successReceiver, successEventId)
  const successSenderNotice = waitForNotification(successSockets.senderSocket, successEventId)
  const successReceiverNotice = waitForNotification(successSockets.receiverSocket, successEventId)
  const paymentEvent = (eventId: string, senderId: string, receiverId: string) => ({
    eventId,
    eventType: 'payment.succeeded',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    data: { paymentId: randomUUID(), senderId, receiverId, amount: '50000' }
  })
  await publisher.publish(paymentEvent(successEventId, successSender, successReceiver))
  const [senderNotice, receiverNotice] = await Promise.all([
    successSenderNotice,
    successReceiverNotice
  ])
  assert.equal(senderNotice.message, 'Bạn đã chuyển 50.000đ cho Trần B.')
  assert.equal(receiverNotice.message, 'Bạn nhận 50.000đ từ Nguyễn A.')
  assert.ok(lookupObservedCommittedGeneric.has(successEventId))
  assert.equal(await prisma.notification.count({
    where: { eventId: successEventId, message: 'Bạn đã chuyển 50.000đ cho Trần B.' }
  }), 1)
  assert.equal(await prisma.notification.count({
    where: { eventId: successEventId, message: 'Bạn nhận 50.000đ từ Nguyễn A.' }
  }), 1)

  const failedEventId = randomUUID()
  const failedSender = randomUUID()
  const failedReceiver = randomUUID()
  eventIds.add(failedEventId)
  failedUsers.add(failedSender)
  failedUsers.add(failedReceiver)
  const failedSockets = await issue(failedSender, failedReceiver, failedEventId)
  const failedSenderNotice = waitForNotification(failedSockets.senderSocket, failedEventId)
  const failedReceiverNotice = waitForNotification(failedSockets.receiverSocket, failedEventId)
  const failedEvent = paymentEvent(failedEventId, failedSender, failedReceiver)
  const requestCountBeforeFailure = requestHeaders.length
  await publisher.publish(failedEvent)
  const [genericSenderNotice, genericReceiverNotice] = await Promise.all([
    failedSenderNotice,
    failedReceiverNotice
  ])
  assert.equal(genericSenderNotice.message, 'Bạn đã chuyển 50.000đ cho một người dùng.')
  assert.equal(genericReceiverNotice.message, 'Bạn nhận 50.000đ từ một người dùng.')
  assert.equal(requestHeaders.length - requestCountBeforeFailure, 2)
  const callsAfterFirstDelivery = requestHeaders.length

  let duplicateEmissions = 0
  failedSockets.senderSocket.on('notification:new', notification => {
    if (notification.eventId === failedEventId) duplicateEmissions += 1
  })
  failedSockets.receiverSocket.on('notification:new', notification => {
    if (notification.eventId === failedEventId) duplicateEmissions += 1
  })
  await publisher.publish(failedEvent)
  await delay(300)
  assert.equal(requestHeaders.length, callsAfterFirstDelivery)
  assert.equal(duplicateEmissions, 0)
  assert.equal(await prisma.notificationInbox.count({ where: { eventId: failedEventId } }), 1)

  const updateFailureEventId = randomUUID()
  const updateFailureSender = randomUUID()
  const updateFailureReceiver = randomUUID()
  eventIds.add(updateFailureEventId)
  names.set(updateFailureSender, 'Lê Minh Long')
  names.set(updateFailureReceiver, 'Phạm Thu Hà')
  const updateFailureSockets = await issue(
    updateFailureSender,
    updateFailureReceiver,
    updateFailureEventId
  )
  const updateSenderNotice = waitForNotification(updateFailureSockets.senderSocket, updateFailureEventId)
  const updateReceiverNotice = waitForNotification(updateFailureSockets.receiverSocket, updateFailureEventId)
  failUpdates = true
  await publisher.publish(paymentEvent(updateFailureEventId, updateFailureSender, updateFailureReceiver))
  const [updateSenderGeneric, updateReceiverGeneric] = await Promise.all([
    updateSenderNotice,
    updateReceiverNotice
  ])
  failUpdates = false
  assert.equal(updateSenderGeneric.message, 'Bạn đã chuyển 50.000đ cho một người dùng.')
  assert.equal(updateReceiverGeneric.message, 'Bạn nhận 50.000đ từ một người dùng.')
  assert.equal(
    logs.some(log => log.includes('simulated notification update failure')),
    true,
    `Expected update failure to be logged; logs: ${logs.join('\n')}`
  )
  assert.equal(logs.some(log => log.includes('Lê Minh Long') || log.includes('Phạm Thu Hà')), false)
  assert.equal(await prisma.notification.count({
    where: { eventId: updateFailureEventId, message: 'Bạn đã chuyển 50.000đ cho một người dùng.' }
  }), 1)

  await queueConsumer.stop()
  const noUrlEventId = randomUUID()
  const noUrlSender = randomUUID()
  const noUrlReceiver = randomUUID()
  eventIds.add(noUrlEventId)
  const noUrlQueue = `${queue}.no-url`
  const noUrlConsumer = createFinanceEventsConsumer(env.rabbitmqUrl!, noUrlQueue, {
    userLookup: createUserLookupClient({ internalKey: env.internalKey })
  })
  await noUrlConsumer.start()
  const noUrlSockets = await issue(noUrlSender, noUrlReceiver, noUrlEventId)
  const noUrlSenderNotice = waitForNotification(noUrlSockets.senderSocket, noUrlEventId)
  const noUrlReceiverNotice = waitForNotification(noUrlSockets.receiverSocket, noUrlEventId)
  const requestsWithoutUrl = requestHeaders.length
  try {
    await publisher.publish(paymentEvent(noUrlEventId, noUrlSender, noUrlReceiver))
    const [noUrlSenderMessage, noUrlReceiverMessage] = await Promise.all([
      noUrlSenderNotice,
      noUrlReceiverNotice
    ])
    assert.equal(noUrlSenderMessage.message, 'Bạn đã chuyển 50.000đ cho một người dùng.')
    assert.equal(noUrlReceiverMessage.message, 'Bạn nhận 50.000đ từ một người dùng.')
    assert.equal(requestHeaders.length, requestsWithoutUrl)
    assert.equal(await prisma.notificationInbox.count({ where: { eventId: noUrlEventId } }), 1)
  } finally {
    await noUrlConsumer.stop()
  }

  assert.ok(requestHeaders.length >= 6)
  assert.ok(requestHeaders.every(header => header === env.internalKey))
  const logsText = logs.join('\n')
  for (const privateName of names.values()) assert.equal(logsText.includes(privateName), false)
  const dlq = await rabbitChannel.checkQueue(`${queue}.dlq`)
  assert.equal(dlq.messageCount, 0)
  console.log('Enrichment integration PASS: post-commit lookup, private internal header, 5xx and no-URL fallback, duplicate suppression, and update-failure fallback verified')
})
