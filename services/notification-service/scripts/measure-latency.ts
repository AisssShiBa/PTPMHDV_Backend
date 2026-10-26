import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { io as createSocketClient, type Socket } from 'socket.io-client'
import { createPublisher } from 'finvault-events'
import { createTestGatewayToken } from 'finvault-internal-auth'
import { env } from '../src/config/env'
import { prisma } from '../src/config/prisma'

const socketUrl = process.env.NOTIFICATION_SOCKET_URL ?? `http://localhost:${env.port}`
const userId = process.env.NOTIFICATION_TEST_USER_ID ?? randomUUID()

async function getSocketTicket(): Promise<string> {
  const gatewayToken = process.env.NOTIFICATION_GATEWAY_TOKEN ??
    (env.isProduction
      ? (() => { throw new Error('NOTIFICATION_GATEWAY_TOKEN is required in production') })()
      : createTestGatewayToken(userId))
  const response = await fetch(new URL('/api/notifications/socket-ticket', socketUrl), {
    headers: { 'x-gateway-token': gatewayToken }
  })
  if (!response.ok) throw new Error(`Socket ticket request failed with HTTP ${response.status}`)
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null || !('data' in body) ||
      typeof body.data !== 'object' || body.data === null ||
      !('ticket' in body.data) || typeof body.data.ticket !== 'string') {
    throw new Error('Socket ticket response is malformed')
  }
  return body.data.ticket
}

function connectSocket(ticket: string): Promise<Socket> {
  const socket = createSocketClient(socketUrl, {
    auth: { token: ticket },
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    timeout: 3000,
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

function waitForEvent(socket: Socket, eventId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('notification:new', listener)
      reject(new Error(`Timed out waiting for notification event ${eventId}`))
    }, 10_000)
    const listener = (notification: { eventId?: string }) => {
      if (notification.eventId !== eventId) return
      clearTimeout(timeout)
      socket.off('notification:new', listener)
      resolve(performance.now())
    }
    socket.on('notification:new', listener)
  })
}

async function main(): Promise<void> {
  if (!env.rabbitmqUrl) throw new Error('RABBITMQ_URL is required')
  const publisher = createPublisher({ url: env.rabbitmqUrl })
  let socket: Socket | undefined
  const eventIds: string[] = []
  const samples: number[] = []

  try {
    socket = await connectSocket(await getSocketTicket())
    for (let index = 1; index <= 10; index += 1) {
      const eventId = randomUUID()
      eventIds.push(eventId)
      const received = waitForEvent(socket, eventId)
      await publisher.publish({
        eventId,
        eventType: 'payment.succeeded',
        eventVersion: 1,
        occurredAt: new Date().toISOString(),
        data: {
          paymentId: randomUUID(),
          senderId: randomUUID(),
          receiverId: userId,
          amount: '50000'
        }
      })
      const publishResolvedAt = performance.now()
      const receivedAt = await received
      const latencyMs = Math.max(0, receivedAt - publishResolvedAt)
      samples.push(latencyMs)
      console.log(`R1 ${index}/10: ${latencyMs.toFixed(1)} ms`)
    }

    const withinThreshold = samples.filter(sample => sample <= 3000).length
    console.log(`R1 result: ${withinThreshold}/10 samples <= 3000 ms`)
    console.log(`R1 conclusion: ${withinThreshold >= 9 ? 'PASS' : 'FAIL'} (at least 9/10 <= 3000 ms)`)
    assert.ok(withinThreshold >= 9, `Expected at least 9/10 samples <= 3000 ms; got ${withinThreshold}/10`)
  } finally {
    socket?.close()
    await publisher.close()
    if (eventIds.length > 0) {
      await prisma.notification.deleteMany({ where: { eventId: { in: eventIds } } })
      await prisma.notificationInbox.deleteMany({ where: { eventId: { in: eventIds } } })
    }
    await prisma.$disconnect()
  }
}

void main().catch((error: unknown) => {
  console.error('R1 measurement failed:', error)
  process.exitCode = 1
})
