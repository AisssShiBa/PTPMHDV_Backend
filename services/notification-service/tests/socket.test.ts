import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'
import { io as createClient, type Socket } from 'socket.io-client'
import { createTestGatewayToken } from 'finvault-internal-auth'
import app from '../src/app'
import { createSocketServer } from '../src/socket'

const clients = new Set<Socket>()
let httpServer: http.Server
let socketServer: ReturnType<typeof createSocketServer>
let baseUrl: string

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

const makeFreshToken = async (userId: string) => {
  await delay(2)
  return createTestGatewayToken(userId)
}

const openSocket = (url: string, options: Parameters<typeof createClient>[1] = {}) => {
  const socket = createClient(url, {
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    timeout: 1000,
    transports: ['websocket'],
    ...options
  })
  clients.add(socket)

  return new Promise<Socket>((resolve, reject) => {
    socket.once('connect', () => resolve(socket))
    socket.once('connect_error', (error) => {
      socket.close()
      reject(error)
    })
    socket.connect()
  })
}

const assertRejected = async (url: string, options: Parameters<typeof createClient>[1] = {}) => {
  await assert.rejects(openSocket(url, options), (error: unknown) =>
    error instanceof Error && error.message === 'INVALID_GATEWAY_TOKEN'
  )
}

const getSocketTicket = async (userId: string): Promise<string> => {
  const gatewayToken = createTestGatewayToken(userId)
  const response = await fetch(`${baseUrl}/api/notifications/socket-ticket`, {
    headers: { 'x-gateway-token': gatewayToken }
  })
  assert.equal(response.status, 200)
  const body = await response.json() as { data: { ticket: string } }
  return body.data.ticket
}

before(async () => {
  httpServer = http.createServer(app)
  socketServer = createSocketServer(httpServer, { maxAgeMs: 300 })
  await new Promise<void>((resolve, reject) => {
    httpServer.once('listening', resolve)
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1')
  })
  const address = httpServer.address()
  assert.ok(address && typeof address !== 'string')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  for (const client of clients) client.close()
  await new Promise<void>((resolve) => socketServer.close(() => resolve()))
})

test('socket rejects a missing Gateway Token', async () => {
  await assertRejected(baseUrl)
})

test('socket rejects a malformed Gateway Token', async () => {
  await assertRejected(baseUrl, { auth: { token: 'not-a-token' } })
})

test('socket rejects an expired Gateway Token', async () => {
  const token = createTestGatewayToken('00000000-0000-4000-8000-000000000004', 'USER', 0, '-1s')
  await assertRejected(baseUrl, { auth: { token } })
})

test('socket rooms deliver notifications only to the matching user', async () => {
  const userA = '00000000-0000-4000-8000-000000000005'
  const userB = '00000000-0000-4000-8000-000000000006'
  const tokenA = await makeFreshToken(userA)
  const tokenB = await makeFreshToken(userB)
  const socketA = await openSocket(baseUrl, { auth: { token: tokenA } })
  const socketB = await openSocket(baseUrl, { auth: { token: tokenB } })
  await delay(20)

  let receivedByB = false
  const receivedByA = new Promise<void>((resolve) => {
    socketA.once('notification:new', () => resolve())
  })
  socketB.once('notification:new', () => {
    receivedByB = true
  })

  socketServer.to(`user:${userA}`).emit('notification:new', { userId: userA })
  await receivedByA
  await delay(30)

  assert.equal(receivedByB, false)
})

test('a Gateway Token jti can be used only once', async () => {
  const token = await makeFreshToken('00000000-0000-4000-8000-000000000007')
  const firstSocket = await openSocket(baseUrl, { auth: { token } })
  firstSocket.close()
  await delay(10)
  await assertRejected(baseUrl, { auth: { token } })
})

test('a socket ticket can be used once through auth.ticket', async () => {
  const ticket = await getSocketTicket('00000000-0000-4000-8000-000000000010')
  const firstSocket = await openSocket(baseUrl, { auth: { ticket } })
  firstSocket.close()
  await delay(10)
  await assertRejected(baseUrl, { auth: { ticket } })
})

test('socket ignores Gateway Token supplied only in the query string', async () => {
  const token = await makeFreshToken('00000000-0000-4000-8000-000000000008')
  await assertRejected(`${baseUrl}?token=${encodeURIComponent(token)}`)
})

test('socket disconnects when its maximum age is reached', async () => {
  const token = await makeFreshToken('00000000-0000-4000-8000-000000000009')
  const socket = await openSocket(baseUrl, { auth: { token } })
  const disconnectReason = new Promise<string>((resolve) => {
    socket.once('disconnect', (reason) => resolve(reason))
  })

  assert.equal(await disconnectReason, 'io server disconnect')
})
