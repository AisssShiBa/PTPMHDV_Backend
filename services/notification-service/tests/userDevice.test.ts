import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { createTestGatewayToken } from 'finvault-internal-auth'
import { prisma } from '../src/config/prisma'
import app from '../src/app'

let server: ReturnType<typeof app.listen>
let baseUrl: string
const createdUserIds = new Set<string>()

const newUser = () => {
  const userId = randomUUID()
  createdUserIds.add(userId)
  return userId
}

const call = (userId: string | undefined, path: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(userId === undefined ? {} : { 'x-gateway-token': createTestGatewayToken(userId) }),
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers
    }
  })

const register = (userId: string, body: Record<string, unknown>) =>
  call(userId, '/api/notifications/devices', { method: 'POST', body: JSON.stringify(body) })

before(async () => {
  server = app.listen(0)
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await prisma.userDevice.deleteMany({ where: { userId: { in: [...createdUserIds] } } })
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()))
  })
  await prisma.$disconnect()
})

test('registering a new device returns 201 and the list contains exactly one row', async () => {
  const userId = newUser()
  const created = await register(userId, { deviceId: 'device-1', platform: 'ANDROID' })
  assert.equal(created.status, 201)

  const response = await call(userId, '/api/notifications/devices')
  const body = await response.json()
  assert.equal(body.data.devices.length, 1)
})

test('re-registering the same deviceId returns 200, updates fields and keeps one row', async () => {
  const userId = newUser()
  await register(userId, { deviceId: 'device-1', platform: 'ANDROID' })
  const second = await register(userId, {
    deviceId: 'device-1',
    platform: 'IOS',
    pushToken: 'push-token-value'
  })
  const body = await second.json()
  const count = await prisma.userDevice.count({ where: { userId } })

  assert.equal(second.status, 200)
  assert.equal(body.data.platform, 'IOS')
  assert.equal(body.data.hasPushToken, true)
  assert.equal(count, 1)
})

test('ten concurrent registrations of the same device create one row and no server error', async () => {
  const userId = newUser()
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => register(userId, { deviceId: 'concurrent', platform: 'WEB' }))
  )
  const count = await prisma.userDevice.count({ where: { userId } })

  assert.equal(count, 1)
  assert.ok(responses.every(response => response.status === 200 || response.status === 201))
})

test('the eleventh active device is rejected with DEVICE_LIMIT_REACHED', async () => {
  const userId = newUser()
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await register(userId, { deviceId: `device-${index}`, platform: 'WEB' })).status, 201)
  }
  const response = await register(userId, { deviceId: 'device-10', platform: 'WEB' })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, 'DEVICE_LIMIT_REACHED')
})

test('a revoked device does not count toward the active device limit', async () => {
  const userId = newUser()
  const ids: string[] = []
  for (let index = 0; index < 10; index += 1) {
    const response = await register(userId, { deviceId: `device-${index}`, platform: 'WEB' })
    ids.push((await response.json()).data.id)
  }
  assert.equal((await call(userId, `/api/notifications/devices/${ids[0]}`, { method: 'DELETE' })).status, 200)
  assert.equal((await register(userId, { deviceId: 'device-10', platform: 'WEB' })).status, 201)
})

test('re-registering a revoked device is rejected when 10 devices are already active', async () => {
  const userId = newUser()
  const ids: string[] = []
  for (let index = 0; index < 10; index += 1) {
    const response = await register(userId, { deviceId: `device-${index}`, platform: 'WEB' })
    ids.push((await response.json()).data.id)
  }
  await call(userId, `/api/notifications/devices/${ids[0]}`, { method: 'DELETE' })
  assert.equal((await register(userId, { deviceId: 'device-10', platform: 'WEB' })).status, 201)

  const response = await register(userId, { deviceId: 'device-0', platform: 'WEB' })

  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, 'DEVICE_LIMIT_REACHED')
  const revoked = await prisma.userDevice.findFirstOrThrow({
    where: { userId, deviceId: 'device-0' }
  })
  assert.notEqual(revoked.revokedAt, null)
})

test('an invalid deviceId is rejected with 400', async () => {
  const userId = newUser()
  const response = await register(userId, { deviceId: 'not allowed!', platform: 'WEB' })
  assert.equal(response.status, 400)
})

test('a deviceId longer than 128 characters is rejected with 400', async () => {
  const userId = newUser()
  const response = await register(userId, { deviceId: 'a'.repeat(129), platform: 'WEB' })
  assert.equal(response.status, 400)
})

test('an unknown platform is rejected with 400', async () => {
  const userId = newUser()
  const response = await register(userId, { deviceId: 'device-1', platform: 'WINDOWS' })
  assert.equal(response.status, 400)
})

test('device responses never include the push token', async () => {
  const userId = newUser()
  const secret = 'SECRET-TOKEN-123'
  const created = await register(userId, {
    deviceId: 'device-1',
    platform: 'ANDROID',
    pushToken: secret
  })
  const list = await call(userId, '/api/notifications/devices')
  const serialized = JSON.stringify(await created.json()) + JSON.stringify(await list.json())

  assert.equal(serialized.includes(secret), false)
  assert.equal(serialized.includes('pushToken'), false)
})

test('another user cannot list or delete a device they do not own', async () => {
  const owner = newUser()
  const stranger = newUser()
  const created = await register(owner, { deviceId: 'device-1', platform: 'WEB' })
  const deviceId = (await created.json()).data.id

  const list = await call(stranger, '/api/notifications/devices')
  const remove = await call(stranger, `/api/notifications/devices/${deviceId}`, { method: 'DELETE' })

  assert.equal((await list.json()).data.devices.length, 0)
  assert.equal(remove.status, 404)
})

test('deleting a device twice is idempotent and keeps the first revokedAt', async () => {
  const userId = newUser()
  const created = await register(userId, { deviceId: 'device-1', platform: 'WEB' })
  const id = (await created.json()).data.id

  const first = await call(userId, `/api/notifications/devices/${id}`, { method: 'DELETE' })
  const firstRevokedAt = (await first.json()).data.revokedAt
  const second = await call(userId, `/api/notifications/devices/${id}`, { method: 'DELETE' })
  const secondRevokedAt = (await second.json()).data.revokedAt

  assert.equal(second.status, 200)
  assert.equal(secondRevokedAt, firstRevokedAt)
})

test('deleting with a non-UUID id is rejected with 400', async () => {
  const userId = newUser()
  const response = await call(userId, '/api/notifications/devices/not-a-uuid', { method: 'DELETE' })
  assert.equal(response.status, 400)
})

test('re-registering a revoked device clears revokedAt', async () => {
  const userId = newUser()
  const created = await register(userId, { deviceId: 'device-1', platform: 'WEB' })
  const id = (await created.json()).data.id
  await call(userId, `/api/notifications/devices/${id}`, { method: 'DELETE' })

  const again = await register(userId, { deviceId: 'device-1', platform: 'WEB' })
  assert.equal((await again.json()).data.revokedAt, null)
})

test('the devices routes require a Gateway token', async () => {
  const response = await call(undefined, '/api/notifications/devices')
  assert.equal(response.status, 401)
})
