import { Request, Response, NextFunction } from 'express'
import { AppError } from '../utils/errors'

interface RateLimitRecord {
  count: number
  resetTime: number
}

const store: Map<string, RateLimitRecord> = new Map()

// Dọn dẹp bản ghi hết hạn mỗi 60 giây để tối ưu RAM
setInterval(() => {
  const now = Date.now()
  for (const [key, record] of store.entries()) {
    if (record.resetTime <= now) {
      store.delete(key)
    }
  }
}, 60_000)

/**
 * Middleware giới hạn tần suất gọi API (Rate Limiting) theo IP
 * @param windowMs Thời gian tính cửa sổ (mili-giây), mặc định 15 phút
 * @param max Số lượng yêu cầu tối đa cho phép trong cửa sổ, mặc định 30
 */
export const rateLimiter = (
  windowMs: number = 15 * 60 * 1000,
  max: number = 30
) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const forwarded = req.headers['x-forwarded-for']
    const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.ip) || 'unknown-client'
    const now = Date.now()

    const record = store.get(ip)

    if (!record || record.resetTime <= now) {
      store.set(ip, {
        count: 1,
        resetTime: now + windowMs
      })
      return next()
    }

    record.count += 1

    if (record.count > max) {
      const waitSeconds = Math.ceil((record.resetTime - now) / 1000)
      return next(
        new AppError(
          429,
          'TOO_MANY_REQUESTS',
          `Quá nhiều lượt thử đăng nhập/đăng ký. Vui lòng thử lại sau ${waitSeconds} giây.`
        )
      )
    }

    next()
  }
}
