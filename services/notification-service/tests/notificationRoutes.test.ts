import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { createTestGatewayToken } from 'finvault-internal-auth'
import { prisma } from '../src/config/prisma'
import app from '../src/app'

const userA = randomUUID()
const userB = randomUUID()
const tokenA = createTestGatewayToken(userA)
let server: ReturnType<typeof app.listen>
let baseUrl: string
let notificationBId: string

before(async () => {
  const notifications = await prisma.notification.createManyAndReturn({
    data: [
      ...Array.from({ length: 55 }, (_, index) => ({
        userId: userA,
        type: 'PAYMENT_SUCCESS' as const,
        message: `Thông báo của A ${index + 1}.`,
        read: index === 0
      })),
      {
        userId: userB,
        type: 'PAYMENT_SUCCESS',
        message: 'Thông báo riêng của B.',
        read: false
      }
    ]
  })
  notificationBId = notifications.find((notification) => notification.userId === userB)!.id

  server = app.listen(0)
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
  await prisma.notification.deleteMany({
    where: { userId: { in: [userA, userB] } }
  })
  await prisma.$disconnect()
})

const requestAsA = (path: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      'x-user-id': 'forged-user',
      'x-gateway-token': tokenA
    }
  })

test('GET /me returns only the authenticated user notifications and database unread count', async () => {
  const response = await requestAsA('/api/notifications/me')
  assert.equal(response.status, 200)
  const body = await response.json()

  assert.equal(body.success, true)
  assert.equal(body.data.notifications.length, 10)
  assert.ok(body.data.notifications.every((notification: { userId: string }) => notification.userId === userA))
  assert.equal(body.data.unreadCount, 54)
  assert.deepEqual(body.data.pagination, {
    page: 1,
    limit: 10,
    total: 55,
    totalPages: 6
  })
})

test('legacy user-ID GET route is removed', async () => {
  const response = await requestAsA(`/api/notifications/${userB}`, {
    headers: { 'x-request-id': 'legacy-get-route' }
  })
  assert.equal(response.status, 404)
  const body = await response.json()
  assert.equal(body.error.code, 'NOT_FOUND')
  assert.equal(body.requestId, 'legacy-get-route')
})

test('legacy user-ID read-all route is removed', async () => {
  const response = await requestAsA(`/api/notifications/${userB}/read-all`, {
    method: 'PATCH'
  })
  assert.equal(response.status, 404)
})

test('a user cannot read another user notification or learn whether it exists', async () => {
  const response = await requestAsA(`/api/notifications/${notificationBId}/read`, {
    method: 'PATCH'
  })
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error.code, 'NOT_FOUND')
  const notification = await prisma.notification.findUnique({ where: { id: notificationBId } })
  assert.equal(notification?.read, false)
})

test('read-all only updates notifications owned by the authenticated user', async () => {
  const response = await requestAsA('/api/notifications/me/read-all', {
    method: 'PATCH'
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    success: true,
    data: { updatedCount: 54 }
  })

  const notificationB = await prisma.notification.findUnique({ where: { id: notificationBId } })
  assert.equal(notificationB?.read, false)
  const unreadA = await prisma.notification.count({
    where: { userId: userA, read: false }
  })
  assert.equal(unreadA, 0)
})

test('GET /me clamps the page size to 50', async () => {
  const response = await requestAsA('/api/notifications/me?limit=1000')
  assert.equal(response.status, 200)
  const body = await response.json()

  assert.equal(body.data.notifications.length, 50)
  assert.equal(body.data.pagination.limit, 50)
  assert.equal(body.data.pagination.total, 55)
})
