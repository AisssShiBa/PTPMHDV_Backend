import { Request, Response, NextFunction } from 'express'
import { env } from '../config/env'

// InternalAuth: xác thực cho các route Internal (do Payment/Wallet Outbox Scheduler gọi).
// Header: x-internal-key — key phải ĐỒNG BỘ với toàn hệ (Gateway + Payment + Wallet).
export const internalAuth = (req: Request, res: Response, next: NextFunction) => {
  const internalKey = req.headers['x-internal-key']
  const expectedKey = env.internalKey

  if (!expectedKey) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'INTERNAL_KEY chưa được cấu hình' }
    })
  }

  if (!internalKey || internalKey !== expectedKey) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid or missing x-internal-key' }
    })
  }

  return next()
}
