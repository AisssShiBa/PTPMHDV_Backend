import assert from 'node:assert/strict'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { io as createClient, type Socket } from 'socket.io-client'
import { createTestGatewayToken } from 'finvault-internal-auth'
import app from '../src/app'
import { createSocketServer } from '../src/socket'
import { prisma } from '../src/config/prisma'

let httpServer: http.Server
let socketServer: ReturnType<typeof createSocketServer>
let baseUrl: string
const clients = new Set<Socket>()
const userIds = new Set<string>()
const touches: Array<{ userId: string; deviceId: string }> = []

const newUser = () => {
  const userId = randomUUID()
  userIds.add(userId)
  return userId
}

const openSocket = (ticket: string) => {
  const socket = createClient(baseUrl, {
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    timeout: 1000,
    transports: ['websocket'],
    auth: { ticket }
  })
  clients.add(socket)
  return new Promise<Socket>((resolve, reject) => {
    socket.once('connect', () => resolve(socket))
    socket.once('connect_error', error => {
      socket.close()
      reject(error)
    })
    socket.connect()
  })
}

const register = async (userId: string, deviceId: string) => {
  const response = await fetch(`${baseUrl}/api/notifications/devices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-gateway-token': createTestGatewayToken(userId)
    },
    body: JSON.stringify({ deviceId, platform: 'WEB' })
  })
  assert.equal(response.status, 201)
  return (await response.json()).data as { id: string; deviceId: string }
}

const getTicket = (userId: string, deviceId?: string) =>
  fetch(`${baseUrl}/api/notifications/socket-ticket${
    deviceId === undefined ? '' : `?deviceId=${encodeURIComponent(deviceId)}`
  }`, { headers: { 'x-gateway-token': createTestGatewayToken(userId) } })

const revoke = (userId: string, id: string) =>
  fetch(`${baseUrl}/api/notifications/devices/${id}`, {
    method: 'DELETE',
    headers: { 'x-gateway-token': createTestGatewayToken(userId) }
  })

// Yields the event loop without sleeping; socket.io dispatches the server
// connection handler on a later tick than the client connect acknowledgement.
const waitUntil = async (predicate: () => boolean): Promise<boolean> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return true
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  return predicate()
}

before(async () => {
  httpServer = http.createServer(app)
  socketServer = createSocketServer(httpServer, {
    maxAgeMs: 60_000,
    touchDevice: async (userId, deviceId) => {
      touches.push({ userId, deviceId })
    }
  })
  await new Promise<void>((resolve, reject) => {
    httpServer.once('listening', resolve)
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1')
  })
  const address = httpServer.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  for (const client of clients) client.close()
  await prisma.userDevice.deleteMany({ where: { userId: { in: [...userIds] } } })
  await new Promise<void>(resolve => socketServer.close(() => resolve()))
  await prisma.$disconnect()
})

test('a device ticket joins the device room and receives an event emitted to it', async () => {
  const userId = newUser()
  const device = await register(userId, 'device-room')
  const ticketResponse = await getTicket(userId, 'device-room')
  assert.equal(ticketResponse.status, 200)
  const { ticket } = (await ticketResponse.json()).data

  const socket = await openSocket(ticket)
  const received = new Promise<void>(resolve => socket.once('notification:new', () => resolve()))
  socketServer.to(`device:${userId}:${device.deviceId}`).emit('notification:new', { userId })
  await received

  assert.equal(socket.connected, true)
})

test('a socket ticket for a revoked device is rejected with DEVICE_REVOKED', async () => {
  const userId = newUser()
  const device = await register(userId, 'device-revoked')
  await revoke(userId, device.id)

  const response = await getTicket(userId, 'device-revoked')
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error.code, 'DEVICE_REVOKED')
})

test('a socket ticket without deviceId keeps the previous connection behavior', async () => {
  const userId = newUser()
  const ticketResponse = await getTicket(userId)
  assert.equal(ticketResponse.status, 200)
  const { ticket } = (await ticketResponse.json()).data

  const socket = await openSocket(ticket)
  assert.equal(socket.connected, true)
})

test('revoking a device disconnects only that device socket', async () => {
  const userId = newUser()
  const first = await register(userId, 'device-a')
  const second = await register(userId, 'device-b')
  const firstTicket = (await (await getTicket(userId, first.deviceId)).json()).data.ticket
  const secondTicket = (await (await getTicket(userId, second.deviceId)).json()).data.ticket
  const firstSocket = await openSocket(firstTicket)
  const secondSocket = await openSocket(secondTicket)

  const disconnected = new Promise<void>(resolve => firstSocket.once('disconnect', () => resolve()))
  await revoke(userId, first.id)
  await disconnected

  assert.equal(secondSocket.connected, true)
})

test('connecting and disconnecting a device socket updates lastSeenAt through the injected clock hook', async () => {
  const userId = newUser()
  await register(userId, 'device-touch')
  const { ticket } = (await (await getTicket(userId, 'device-touch')).json()).data
  const socket = await openSocket(ticket)
  const connected = await waitUntil(() => touches.filter(touch => touch.userId === userId).length >= 1)
  const disconnected = new Promise<void>(resolve => socket.once('disconnect', () => resolve()))
  socket.close()
  await disconnected
  const disconnectedTouch = await waitUntil(() => touches.filter(touch => touch.userId === userId).length >= 2)

  assert.equal(connected && disconnectedTouch, true)
})
