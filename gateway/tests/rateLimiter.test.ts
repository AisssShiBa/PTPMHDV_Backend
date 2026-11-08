// D:\PTPMHDV\Backend\gateway\tests\rateLimiter.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import { rateLimiter } from '../src/middlewares/rateLimiter'
import { redisClient } from '../src/config/redis'

/**
 * Helper tạo đối tượng giả lập Express req, res, next
 */
const createMockReqRes = (options: {
    ip?: string
    path?: string
    method?: string
    headers?: Record<string, string>
}) => {
    const headers = options.headers || {}
    const resHeaders: Record<string, any> = {}

    const req: any = {
        ip: options.ip || '127.0.0.1',
        path: options.path || '/api/users/profile',
        method: options.method || 'GET',
        headers,
        socket: { remoteAddress: options.ip || '127.0.0.1' }
    }

    const res: any = {
        statusCode: 200,
        responseData: null,
        setHeader(name: string, value: any) {
            resHeaders[name.toLowerCase()] = value
            return this
        },
        getHeader(name: string) {
            return resHeaders[name.toLowerCase()]
        },
        status(code: number) {
            this.statusCode = code
            return this
        },
        json(data: any) {
            this.responseData = data
            return this
        }
    }

    return { req, res, resHeaders }
}

test('Kịch bản nghiệm thu RL1: Rate limit Redis tại API Gateway (Nhiệm vụ Đ14)', async (t) => {
    // 1. Khởi tạo kho lưu trữ RAM giả lập cho Redis trong test
    const redisStore = new Map<string, { count: number; expiresAt: number }>()

    // Bật cờ trạng thái kết nối Redis giả lập
    ;(redisClient as any).status = 'ready'

    // Mock lệnh Lua script nguyên tử trên Redis
    t.mock.method(redisClient, 'eval', async (_script: string, _numKeys: number, key: string, windowMs: number) => {
        const now = Date.now()
        let record = redisStore.get(key)
        if (!record || record.expiresAt <= now) {
            record = { count: 1, expiresAt: now + Number(windowMs) }
            redisStore.set(key, record)
            return [1, Number(windowMs)]
        }
        record.count += 1
        const ttl = Math.max(1, record.expiresAt - now)
        return [record.count, ttl]
    })

    const limiter = rateLimiter(60 * 1000, 120, 10)
    const clientIp = '203.0.113.195'

    await t.test('1. Gửi 120 requests đầu tiên: Tất cả được thông qua (status 200/next) và headers chính xác', async () => {
        for (let i = 1; i <= 120; i++) {
            const { req, res, resHeaders } = createMockReqRes({ ip: clientIp, path: '/api/users/me' })
            let nextCalled = false

            await limiter(req, res, () => { nextCalled = true })

            assert.equal(nextCalled, true, `Request thứ ${i} phải được cho qua`)
            assert.equal(resHeaders['x-ratelimit-limit'], 120)
            assert.equal(resHeaders['x-ratelimit-remaining'], 120 - i)
        }
    })

    await t.test('2. Gửi request thứ 121: Bị chặn chính xác với HTTP 429 và mã lỗi TOO_MANY_REQUESTS', async () => {
        const { req, res, resHeaders } = createMockReqRes({ ip: clientIp, path: '/api/users/me' })
        let nextCalled = false

        await limiter(req, res, () => { nextCalled = true })

        assert.equal(nextCalled, false, 'Request thứ 121 không được gọi next()')
        assert.equal(res.statusCode, 429, 'Phải trả về mã trạng thái HTTP 429')
        assert.equal(res.responseData?.error?.code, 'TOO_MANY_REQUESTS')
        assert.equal(resHeaders['x-ratelimit-remaining'], 0)
        assert.ok(Number(resHeaders['retry-after']) > 0, 'Header Retry-After phải lớn hơn 0')
    })

    await t.test('3. Kẻ tấn công cố tình giả mạo header X-Forwarded-For: Không thể né tránh giới hạn', async () => {
        // Kẻ tấn công đổi header X-Forwarded-For thành IP lạ, nhưng Express trust proxy vẫn xác định req.ip = clientIp
        const { req, res } = createMockReqRes({
            ip: clientIp,
            path: '/api/users/me',
            headers: { 'x-forwarded-for': '8.8.8.8, 1.1.1.1' }
        })
        let nextCalled = false

        await limiter(req, res, () => { nextCalled = true })

        assert.equal(nextCalled, false, 'Không thể né rate limit bằng cách giả mạo X-Forwarded-For')
        assert.equal(res.statusCode, 429)
    })

    await t.test('4. Khởi động lại Gateway (Restart Gateway): Bộ đếm trên Redis vẫn được bảo toàn', async () => {
        // Giả lập Gateway restart bằng cách tạo instance middleware rateLimiter mới hoàn toàn
        const restartedLimiter = rateLimiter(60 * 1000, 120, 10)

        const { req, res } = createMockReqRes({ ip: clientIp, path: '/api/users/me' })
        let nextCalled = false

        await restartedLimiter(req, res, () => { nextCalled = true })

        assert.equal(nextCalled, false, 'Sau khi Gateway restart, request từ IP đã vượt ngưỡng vẫn bị chặn 429')
        assert.equal(res.statusCode, 429)
    })

    await t.test('5. Giới hạn tần suất theo userId trên route nhạy cảm (/api/auth/pin/verify): Bị chặn sau 10 lần', async () => {
        const newIp = '198.51.100.10'
        const sensitiveUserId = 'user-pin-test-uuid'
        const userToken = jwt.sign({ userId: sensitiveUserId, role: 'USER' }, 'test_secret')

        // Gọi 10 lần đầu vào route xác thực mã PIN
        for (let i = 1; i <= 10; i++) {
            const { req, res } = createMockReqRes({
                ip: newIp,
                path: '/api/auth/pin/verify',
                method: 'POST',
                headers: { authorization: `Bearer ${userToken}` }
            })
            let nextCalled = false

            await limiter(req, res, () => { nextCalled = true })
            assert.equal(nextCalled, true, `Lần verify PIN thứ ${i} của user phải thành công`)
        }

        // Lần thứ 11 trong vòng 1 phút: Bị chặn dù IP mới chỉ gọi 11 lần (dưới ngưỡng 120)
        const { req, res } = createMockReqRes({
            ip: newIp,
            path: '/api/auth/pin/verify',
            method: 'POST',
            headers: { authorization: `Bearer ${userToken}` }
        })
        let nextCalled = false

        await limiter(req, res, () => { nextCalled = true })

        assert.equal(nextCalled, false, 'Lần thứ 11 gọi verify PIN phải bị chặn')
        assert.equal(res.statusCode, 429)
        assert.equal(res.responseData?.error?.code, 'TOO_MANY_REQUESTS')
    })

    await t.test('6. Redis gặp sự cố: Route Auth/PIN phải Fail-Closed (503), Route khác phải Fail-Open (200/next)', async () => {
        // Giả lập Redis rớt kết nối
        ;(redisClient as any).status = 'close'

        // 6.1. Route Auth nhạy cảm (/api/auth/signin): Phải Fail-Closed trả về HTTP 503
        {
            const { req, res } = createMockReqRes({ path: '/api/auth/signin', method: 'POST' })
            let nextCalled = false

            await limiter(req, res, () => { nextCalled = true })

            assert.equal(nextCalled, false, 'Route Auth không được đi tiếp khi Redis chết')
            assert.equal(res.statusCode, 503, 'Auth route phải trả về 503 SERVICE_UNAVAILABLE')
            assert.equal(res.responseData?.error?.code, 'SERVICE_UNAVAILABLE')
        }

        // 6.2. Route PIN nhạy cảm (/api/auth/pin/verify): Phải Fail-Closed trả về HTTP 503
        {
            const { req, res } = createMockReqRes({ path: '/api/auth/pin/verify', method: 'POST' })
            let nextCalled = false

            await limiter(req, res, () => { nextCalled = true })

            assert.equal(nextCalled, false, 'Route PIN không được đi tiếp khi Redis chết')
            assert.equal(res.statusCode, 503, 'PIN route phải trả về 503 SERVICE_UNAVAILABLE')
        }

        // 6.3. Route thông thường (/api/merchants/list): Phải Fail-Open cho qua (next called)
        {
            const { req, res } = createMockReqRes({ path: '/api/merchants/list', method: 'GET' })
            let nextCalled = false

            await limiter(req, res, () => { nextCalled = true })

            assert.equal(nextCalled, true, 'Route thông thường phải được cho qua (Fail-Open) khi Redis chết')
        }

        // Khôi phục trạng thái kết nối Redis
        ;(redisClient as any).status = 'ready'
    })
})

