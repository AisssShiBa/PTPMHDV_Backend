import type { DevicePlatform, UserDevice } from '@prisma/client'
import { prisma } from '../config/prisma'

export const DEVICE_LIMIT = 10
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/
export const PUSH_TOKEN_MAX_LENGTH = 512

export type DeviceView = {
  id: string
  userId: string
  deviceId: string
  platform: DevicePlatform
  lastSeenAt: Date
  revokedAt: Date | null
  createdAt: Date
  hasPushToken: boolean
}

export type RegisterDeviceInput = {
  deviceId: string
  platform: DevicePlatform
  pushToken?: string | null
}

export class DeviceLimitReachedError extends Error {
  constructor() {
    super(`A user may keep at most ${DEVICE_LIMIT} active devices`)
    this.name = 'DeviceLimitReachedError'
  }
}

const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'

export const toDeviceView = (device: UserDevice): DeviceView => ({
  id: device.id,
  userId: device.userId,
  deviceId: device.deviceId,
  platform: device.platform,
  lastSeenAt: device.lastSeenAt,
  revokedAt: device.revokedAt,
  createdAt: device.createdAt,
  hasPushToken: Boolean(device.pushToken)
})

const deviceData = (input: RegisterDeviceInput, now: Date) => ({
  platform: input.platform,
  lastSeenAt: now,
  revokedAt: null,
  // An omitted token must not erase a token registered by an earlier request.
  ...(input.pushToken === undefined ? {} : { pushToken: input.pushToken })
})

export async function registerDevice(
  userId: string,
  input: RegisterDeviceInput,
  now: Date = new Date()
): Promise<{ device: UserDevice; created: boolean }> {
  const existing = await prisma.userDevice.findUnique({
    where: { userId_deviceId: { userId, deviceId: input.deviceId } }
  })
  if (existing) {
    // Re-registering a revoked device makes it active again, so it must obey
    // the same cap as a brand-new device.
    if (existing.revokedAt !== null) {
      const activeCount = await prisma.userDevice.count({
        where: { userId, revokedAt: null }
      })
      if (activeCount >= DEVICE_LIMIT) throw new DeviceLimitReachedError()
    }
    const device = await prisma.userDevice.update({
      where: { id: existing.id },
      data: deviceData(input, now)
    })
    return { device, created: false }
  }

  const activeCount = await prisma.userDevice.count({
    where: { userId, revokedAt: null }
  })
  if (activeCount >= DEVICE_LIMIT) throw new DeviceLimitReachedError()

  try {
    const device = await prisma.userDevice.create({
      data: {
        userId,
        deviceId: input.deviceId,
        platform: input.platform,
        pushToken: input.pushToken ?? null,
        lastSeenAt: now
      }
    })
    return { device, created: true }
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    // A concurrent request created the same (userId, deviceId). Update that row
    // instead of failing the request with a duplicate-key error.
    const raced = await prisma.userDevice.findUnique({
      where: { userId_deviceId: { userId, deviceId: input.deviceId } }
    })
    if (!raced) throw error
    const device = await prisma.userDevice.update({
      where: { id: raced.id },
      data: deviceData(input, now)
    })
    return { device, created: false }
  }
}

export async function listDevices(userId: string): Promise<UserDevice[]> {
  return prisma.userDevice.findMany({
    where: { userId },
    orderBy: { lastSeenAt: 'desc' }
  })
}

export async function findDevice(userId: string, deviceId: string): Promise<UserDevice | null> {
  return prisma.userDevice.findUnique({
    where: { userId_deviceId: { userId, deviceId } }
  })
}

export async function findActiveDevice(userId: string, deviceId: string): Promise<UserDevice | null> {
  const device = await findDevice(userId, deviceId)
  return device && device.revokedAt === null ? device : null
}

export async function revokeDevice(
  userId: string,
  id: string,
  now: Date = new Date()
): Promise<UserDevice | null> {
  const device = await prisma.userDevice.findFirst({ where: { id, userId } })
  if (!device) return null
  if (device.revokedAt !== null) return device
  return prisma.userDevice.update({
    where: { id: device.id },
    data: { revokedAt: now }
  })
}

export async function touchDevice(
  userId: string,
  deviceId: string,
  now: Date = new Date()
): Promise<number> {
  const result = await prisma.userDevice.updateMany({
    where: { userId, deviceId, revokedAt: null },
    data: { lastSeenAt: now }
  })
  return result.count
}
