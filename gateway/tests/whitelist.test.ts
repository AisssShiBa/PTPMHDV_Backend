// D:\PTPMHDV\Backend\gateway\tests\whitelist.test.ts
import path from 'path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'

// Cấu hình đường dẫn khóa mật mã Gateway từ thư mục secrets trước khi import module
const secretsDir = path.resolve(__dirname, '../../secrets')
process.env.GATEWAY_PRIVATE_KEY_FILE = path.join(secretsDir, 'gateway_private.pem')
process.env.GATEWAY_PUBLIC_KEY_FILE = path.join(secretsDir, 'gateway_public.pem')

import { authenticate } from '../src/middlewares/authenticate'
import { verifyGatewayToken } from '../src/utils/gatewayToken'
import { env } from '../src/config/services'

/**
 * Helper tạo đối tượng giả lập Express req, res, next
 */
const createMockReqRes = (options: {
    path: string
    method?: string
    headers?: Record<string, string>
}) => {
    const headers = options.headers || {}
    const req: any = {
        path: options.path,
        method: options.method || 'GET',
        headers
    }

    const res: any = {
        statusCode: 200,
        responseData: null,
        status(code: number) {
            this.statusCode = code
            return this
        },
        json(data: any) {
            this.responseData = data
            return this
        }
    }

    return { req, res }
}

test('Kịch bản nghiệm thu Đ16: Thu hẹp Whitelist Gateway và Xác thực Route Tiện ích', async (t) => {
    const mockUserId = '11111111-2222-3333-4444-555555555555'
    const validClientToken = jwt.sign(
        { userId: mockUserId, role: 'USER' },
        env.accessTokenSecret,
        { expiresIn: '15m' }
    )

    await t.test('1. Lỗ hổng Whitelist đã được vá: /api/funding/cash-out KHÔNG CÒN CÔNG KHAI', async () => {
        // Gọi rút tiền không kèm Token -> Phải bị từ chối 401 UNAUTHORIZED
        const { req, res } = createMockReqRes({
            path: '/api/funding/cash-out',
            method: 'POST'
        })
        let nextCalled = false

        authenticate(req, res, () => { nextCalled = true })

        assert.equal(nextCalled, false, 'Route rút tiền cash-out không được cho qua nếu thiếu token')
        assert.equal(res.statusCode, 401, 'Phải trả về HTTP 401')
        assert.equal(res.responseData?.error?.code, 'UNAUTHORIZED')
    })

    await t.test('2. Các route khác thuộc nhánh /api/funding cũng bắt buộc phải có token', async () => {
        const { req, res } = createMockReqRes({
            path: '/api/funding/wallets',
            method: 'GET'
        })
        let nextCalled = false

        authenticate(req, res, () => { nextCalled = true })

        assert.equal(nextCalled, false)
        assert.equal(res.statusCode, 401)
    })

    await t.test('3. Đúng IPN / Return Webhook của VNPAY vẫn được công khai bình thường', async () => {
        // 3.1. Webhook nạp tiền VNPAY
        {
            const { req, res } = createMockReqRes({
                path: '/api/payments/topups/vnpay/callback',
                method: 'POST'
            })
            let nextCalled = false

            authenticate(req, res, () => { nextCalled = true })
            assert.equal(nextCalled, true, 'VNPAY callback phải được cho qua không cần token')
        }

        // 3.2. Return URL người dùng chuyển hướng về từ VNPAY
        {
            const { req, res } = createMockReqRes({
                path: '/api/payments/topups/vnpay/return',
                method: 'GET'
            })
            let nextCalled = false

            authenticate(req, res, () => { nextCalled = true })
            assert.equal(nextCalled, true, 'VNPAY return URL phải được cho qua')
        }

        // 3.3. Webhook IPN VNPAY nhánh funding
        {
            const { req, res } = createMockReqRes({
                path: '/api/funding/vnpay/ipn',
                method: 'POST'
            })
            let nextCalled = false

            authenticate(req, res, () => { nextCalled = true })
            assert.equal(nextCalled, true, 'VNPAY IPN funding phải được cho qua')
        }
    })

    await t.test('4. Các route công khai tiêu chuẩn (Auth / Health / QR) vẫn hoạt động chính xác', async () => {
        const publicPaths = [
            { path: '/health', method: 'GET' },
            { path: '/api/auth/signin', method: 'POST' },
            { path: '/api/auth/signup', method: 'POST' },
            { path: '/api/auth/refresh', method: 'POST' },
            { path: '/api/auth/qr-login/init', method: 'POST' },
            { path: '/api/auth/qr-login/test-qr-id-123/status', method: 'GET' }
        ]

        for (const item of publicPaths) {
            const { req, res } = createMockReqRes(item)
            let nextCalled = false

            authenticate(req, res, () => { nextCalled = true })
            assert.equal(nextCalled, true, `Route công khai ${item.path} phải được cho qua`)
        }
    })

    await t.test('5. Route Tiện ích (/api/utilities): Bị chặn nếu thiếu token, ký x-gateway-token khi có token (M17)', async () => {
        // 5.1. Khi thiếu token: Bị chặn 401
        {
            const { req, res } = createMockReqRes({
                path: '/api/utilities/mobile-topup',
                method: 'POST'
            })
            let nextCalled = false

            authenticate(req, res, () => { nextCalled = true })
            assert.equal(nextCalled, false)
            assert.equal(res.statusCode, 401)
        }

        // 5.2. Khi gửi kèm Bearer Token hợp lệ: Xác thực thành công và ký Gateway Token
        {
            const { req, res } = createMockReqRes({
                path: '/api/utilities/mobile-topup',
                method: 'POST',
                headers: { authorization: `Bearer ${validClientToken}` }
            })
            let nextCalled = false

            authenticate(req, res, () => { nextCalled = true })

            assert.equal(nextCalled, true, 'Request có token hợp lệ phải được cho qua')
            assert.ok(req.headers['x-gateway-token'], 'Header x-gateway-token phải được sinh ra')
            assert.equal(req.headers['x-user-id'], mockUserId)
            assert.equal(req.headers['x-user-role'], 'USER')

            // Giải mã kiểm chứng x-gateway-token bằng ES256
            const verifiedPayload = verifyGatewayToken(req.headers['x-gateway-token'])
            assert.equal(verifiedPayload.sub, mockUserId)
            assert.equal(verifiedPayload.role, 'USER')
        }
    })
})

