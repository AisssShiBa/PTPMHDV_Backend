// D:\PTPMHDV\Backend\gateway\src\middlewares\rateLimiter.ts
import { Request, Response, NextFunction } from 'express'
import { fail } from '../utils/response'

interface RateLimitRecord {
    count: number
    resetTime: number
}

const store: Map<string, RateLimitRecord> = new Map()

// Tự động dọn dẹp bộ nhớ định kỳ mỗi 60 giây
setInterval(() => {
    const now = Date.now()
    for (const [key, record] of store.entries()) {
        if (record.resetTime <= now) {
            store.delete(key)
        }
    }
}, 60_000)

/**
 * Middleware Rate Limiter tại Gateway chặn spam và DDoS toàn hệ thống
 * @param windowMs Cửa sổ thời gian tính lượt gọi (mặc định: 1 phút = 60,000ms)
 * @param max Số lượng request tối đa từ một IP trong cửa sổ thời gian (mặc định: 120 req/phút)
 */
export const rateLimiter = (
    windowMs: number = 60 * 1000,
    max: number = 120
) => {
    return (req: Request, res: Response, next: NextFunction) => {
        const forwarded = req.headers['x-forwarded-for']
        const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.ip) || 'unknown-client'
        const now = Date.now()

        const record = store.get(ip)

        if (!record || record.resetTime <= now) {
            store.set(ip, {
                count: 1,
                resetTime: now + windowMs
            })
            res.setHeader('X-RateLimit-Limit', max)
            res.setHeader('X-RateLimit-Remaining', max - 1)
            return next()
        }

        record.count += 1
        const remaining = Math.max(0, max - record.count)
        res.setHeader('X-RateLimit-Limit', max)
        res.setHeader('X-RateLimit-Remaining', remaining)

        if (record.count > max) {
            const retryAfterSeconds = Math.ceil((record.resetTime - now) / 1000)
            res.setHeader('Retry-After', retryAfterSeconds)
            return fail(
                res,
                429,
                'TOO_MANY_REQUESTS',
                `Hệ thống phát hiện tần suất yêu cầu bất thường từ IP của bạn. Vui lòng thử lại sau ${retryAfterSeconds} giây.`
            )
        }

        next()
    }
}
