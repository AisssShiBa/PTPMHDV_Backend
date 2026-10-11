import { Request, Response, NextFunction } from 'express'
import { timingSafeEqual } from 'node:crypto'
import { env } from '../config/env'

// InternalAuth: xác thực cho các route Internal (do Payment/Wallet Outbox Scheduler gọi).
// Header: x-internal-key — key phải ĐỒNG BỘ với toàn hệ (Gateway + Payment + Wallet).
export const internalAuth = (req: Request, res: Response, next: NextFunction) => {
  const internalKey = req.headers['x-internal-key']
  const expectedKey = env.internalKey

  const providedKey = typeof internalKey === 'string' ? Buffer.from(internalKey) : null
  const expectedKeyBuffer = Buffer.from(expectedKey)
  const isValid =
    providedKey !== null &&
    providedKey.length === expectedKeyBuffer.length &&
    timingSafeEqual(providedKey, expectedKeyBuffer)

  if (!isValid) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid or missing x-internal-key' }
    })
  }

  return next()
}
