// D:\PTPMHDV\Backend\gateway\src\middlewares\rateLimiter.ts
import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { redisClient, isRedisReady } from '../config/redis'
import { fail } from '../utils/response'

/**
 * Lua script thực thi cửa sổ cố định (Fixed Window Rate Limiting) nguyên tử trên Redis.
 * Trả về mảng 2 phần tử: [current_count, pttl_in_ms]
 */
export const RATE_LIMIT_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
else
    local ttl = redis.call('PTTL', KEYS[1])
    if ttl == -1 then
        redis.call('PEXPIRE', KEYS[1], ARGV[1])
    end
end
local ttl = redis.call('PTTL', KEYS[1])
return { current, ttl }
`

/**
 * Kiểm tra xem endpoint có thuộc nhóm nhạy cảm (Auth / PIN / Giao dịch tiền) hay không.
 * Nếu Redis gặp sự cố, nhóm này PHẢI áp dụng chính sách Fail-Closed (chặn đứng request)
 * để chống tấn công brute-force mật khẩu/PIN.
 */
export const isAuthOrPinRoute = (path: string): boolean => {
    const p = path.toLowerCase()
    return (
        p.startsWith('/api/auth') ||
        p.includes('/pin') ||
        /\/api\/payments\/[^/]+\/confirm/.test(p) ||
        p.includes('/cash-out')
    )
}

/**
 * Nhận diện tác vụ nhạy cảm cần áp dụng giới hạn bảo vệ riêng theo userId
 */
export const getSensitiveAction = (path: string): string | null => {
    const p = path.toLowerCase()
    if (p.includes('/pin/verify')) return 'pin-verify'
    if (/\/api\/payments\/[^/]+\/confirm/.test(p)) return 'payment-confirm'
    if (p.includes('/funding/cash-out')) return 'cash-out'
    return null
}

/**
 * Trích xuất an toàn userId từ header nội bộ hoặc Authorization Bearer JWT
 */
export const extractUserId = (req: Request): string | null => {
    // 1. Kiểm tra header nội bộ x-user-id (nếu request đã qua middleware authenticate)
    const headerUserId = req.headers['x-user-id']
    if (typeof headerUserId === 'string' && headerUserId.trim()) {
        return headerUserId.trim()
    }

    // 2. Nếu chưa qua authenticate, giải mã từ Bearer token (không cần verify signature vì chỉ lấy identity)
    const authHeader = req.headers.authorization
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7)
        try {
            const decoded = jwt.decode(token) as { userId?: string; sub?: string } | null
            if (decoded) {
                return decoded.userId || decoded.sub || null
            }
        } catch {
            return null
        }
    }

    return null
}

/**
 * Helper thực thi Lua Script đếm số lượng request trên Redis
 */
const executeRateLimit = async (key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> => {
    const result = (await redisClient.eval(RATE_LIMIT_LUA, 1, key, windowMs)) as [number, number]
    return {
        count: Number(result[0]),
        ttlMs: Number(result[1])
    }
}

/**
 * Middleware Rate Limiter tập trung tại API Gateway (Nhiệm vụ Đ14)
 * - Sử dụng Redis kết hợp Lua script đảm bảo tính nguyên tử (atomic)
 * - Khóa theo IP: sử dụng req.ip (với Express trust proxy, chống giả mạo X-Forwarded-For)
 * - Khóa bổ sung theo userId cho các route nhạy cảm (pin/verify, payment confirm, cash-out)
 * - Chính sách chịu lỗi: Fail-Closed với Auth/PIN, Fail-Open (có log cảnh báo) với các route thông thường
 * - Đầy đủ Header chuẩn RFC: X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After
 */
export const rateLimiter = (
    windowMs: number = 60 * 1000,
    max: number = 120,
    sensitiveMax: number = 10
) => {
    return async (req: Request, res: Response, next: NextFunction): Promise<void | Response> => {
        const isAuthOrPin = isAuthOrPinRoute(req.path)

        // 1. Kiểm tra trạng thái Redis:
        // Nếu Redis chưa sẵn sàng hoặc rớt kết nối:
        // - Với Auth/PIN: Fail-Closed (chặn lại bằng 503 để kẻ tấn công không thể brute-force khi Redis chết)
        // - Với các route khác: Fail-Open (cho qua và log warning để hệ thống không bị gián đoạn toàn bộ)
        const isHealthy = isRedisReady || (redisClient && redisClient.status === 'ready')
        if (!isHealthy) {
            if (isAuthOrPin) {
                return fail(
                    res,
                    503,
                    'SERVICE_UNAVAILABLE',
                    'Dịch vụ bảo mật tạm thời gián đoạn do hệ thống xác thực. Vui lòng thử lại sau.'
                )
            }
            console.warn(`[RateLimiter] Redis chưa sẵn sàng. Bỏ qua giới hạn tốc độ (fail-open) cho: ${req.method} ${req.path}`)
            return next()
        }

        try {
            // 2. Rate limiting tầng IP (Bảo vệ Gateway chống DDoS và spam)
            // QUAN TRỌNG: Dùng req.ip do Express xử lý từ trust proxy, KHÔNG đọc thô x-forwarded-for
            const clientIp = req.ip || req.socket.remoteAddress || 'unknown-client'
            const ipKey = `rl:ip:${clientIp}`

            const { count: ipCount, ttlMs: ipTtl } = await executeRateLimit(ipKey, windowMs)

            const ipRemaining = Math.max(0, max - ipCount)
            res.setHeader('X-RateLimit-Limit', max)
            res.setHeader('X-RateLimit-Remaining', ipRemaining)

            // Nếu vượt quá giới hạn IP (Ví dụ: request thứ 121 trong 1 phút)
            if (ipCount > max) {
                const retryAfter = ipTtl > 0 ? Math.ceil(ipTtl / 1000) : Math.ceil(windowMs / 1000)
                res.setHeader('Retry-After', retryAfter)
                res.setHeader('X-RateLimit-Remaining', 0)
                return fail(
                    res,
                    429,
                    'TOO_MANY_REQUESTS',
                    `Hệ thống phát hiện tần suất yêu cầu bất thường từ IP của bạn. Vui lòng thử lại sau ${retryAfter} giây.`
                )
            }

            // 3. Rate limiting bổ sung theo userId cho các route nhạy cảm
            const sensitiveAction = getSensitiveAction(req.path)
            if (sensitiveAction) {
                const userId = extractUserId(req)
                if (userId) {
                    const userKey = `rl:user:${userId}:${sensitiveAction}`
                    const { count: userCount, ttlMs: userTtl } = await executeRateLimit(userKey, windowMs)

                    if (userCount > sensitiveMax) {
                        const retryAfter = userTtl > 0 ? Math.ceil(userTtl / 1000) : Math.ceil(windowMs / 1000)
                        res.setHeader('Retry-After', retryAfter)
                        res.setHeader('X-RateLimit-Remaining', 0)
                        return fail(
                            res,
                            429,
                            'TOO_MANY_REQUESTS',
                            `Hệ thống phát hiện tần suất yêu cầu vượt giới hạn cho tác vụ này. Vui lòng thử lại sau ${retryAfter} giây.`
                        )
                    }
                }
            }

            return next()
        } catch (error: any) {
            // Xử lý ngoại lệ kết nối/thực thi Redis:
            if (isAuthOrPin) {
                return fail(
                    res,
                    503,
                    'SERVICE_UNAVAILABLE',
                    'Dịch vụ bảo mật tạm thời gián đoạn do sự cố Redis. Vui lòng thử lại sau.'
                )
            }
            console.warn(`[RateLimiter] Lỗi Redis (${error?.message}). Cho phép đi tiếp (fail-open) cho: ${req.method} ${req.path}`)
            return next()
        }
    }
}
