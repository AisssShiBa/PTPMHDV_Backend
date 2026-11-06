import type { DevicePlatform } from '@prisma/client'
import { Request, Response } from 'express'
import { notificationIO } from '../socket'
import {
  DEVICE_ID_PATTERN,
  DeviceLimitReachedError,
  PUSH_TOKEN_MAX_LENGTH,
  listDevices,
  registerDevice,
  revokeDevice,
  toDeviceView
} from '../services/deviceService'

const PLATFORMS: readonly DevicePlatform[] = ['IOS', 'ANDROID', 'WEB']
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const fail = (req: Request, res: Response, status: number, code: string, message: string) =>
  res.status(status).json({
    success: false,
    error: { code, message },
    requestId: req.get('x-request-id')
  })

const parseBody = (value: unknown): { deviceId: string; platform: DevicePlatform; pushToken?: string } | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const body = value as Record<string, unknown>
  const { deviceId, platform, pushToken } = body
  if (typeof deviceId !== 'string' || deviceId.length < 1 || deviceId.length > 128 ||
      !DEVICE_ID_PATTERN.test(deviceId)) return undefined
  if (typeof platform !== 'string' || !PLATFORMS.includes(platform as DevicePlatform)) return undefined
  if (pushToken !== undefined && pushToken !== null &&
      (typeof pushToken !== 'string' || pushToken.length > PUSH_TOKEN_MAX_LENGTH)) return undefined
  return {
    deviceId,
    platform: platform as DevicePlatform,
    ...(pushToken === undefined || pushToken === null
      ? {}
      : { pushToken })
  }
}

export const createDevice = async (req: Request, res: Response) => {
  const userId = req.auth?.userId
  if (!userId) return fail(req, res, 401, 'INVALID_GATEWAY_TOKEN', 'Gateway Token không hợp lệ hoặc đã hết hạn.')

  const input = parseBody(req.body)
  if (!input) {
    return fail(req, res, 400, 'VALIDATION_ERROR',
      'deviceId, platform hợp lệ là bắt buộc; pushToken tối đa 512 ký tự.')
  }

  try {
    const { device, created } = await registerDevice(userId, input)
    return res.status(created ? 201 : 200).json({
      success: true,
      data: toDeviceView(device)
    })
  } catch (error) {
    if (error instanceof DeviceLimitReachedError) {
      return fail(req, res, 409, 'DEVICE_LIMIT_REACHED', error.message)
    }
    throw error
  }
}

export const getDevices = async (req: Request, res: Response) => {
  const userId = req.auth?.userId
  if (!userId) return fail(req, res, 401, 'INVALID_GATEWAY_TOKEN', 'Gateway Token không hợp lệ hoặc đã hết hạn.')

  const devices = await listDevices(userId)
  return res.status(200).json({
    success: true,
    data: { devices: devices.map(toDeviceView) }
  })
}

export const deleteDevice = async (req: Request, res: Response) => {
  const userId = req.auth?.userId
  if (!userId) return fail(req, res, 401, 'INVALID_GATEWAY_TOKEN', 'Gateway Token không hợp lệ hoặc đã hết hạn.')

  const id = String(req.params.id ?? '')
  if (!UUID_PATTERN.test(id)) {
    return fail(req, res, 400, 'VALIDATION_ERROR', 'id thiết bị phải là UUID hợp lệ.')
  }

  const device = await revokeDevice(userId, id)
  if (!device) {
    // Do not disclose whether the device exists for another user.
    return fail(req, res, 404, 'NOT_FOUND', 'Không tìm thấy thiết bị.')
  }

  try {
    notificationIO?.in(`device:${device.userId}:${device.deviceId}`).disconnectSockets(true)
  } catch (error) {
    // A socket failure must not make the revocation response fail.
    console.error('[Socket] Không thể ngắt socket của thiết bị đã thu hồi:', error)
  }

  return res.status(200).json({
    success: true,
    data: toDeviceView(device)
  })
}
