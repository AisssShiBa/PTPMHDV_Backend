// D:\PTPMHDV\Backend\packages\finvault-internal-auth\test.ts
import jwt, { SignOptions } from 'jsonwebtoken'
import { requireGateway, requireRole } from './src/index'

// Sử dụng Private Key của Gateway (chỉ dùng trong test để giả lập Gateway ký gửi sang)
const DEV_TEST_GATEWAY_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtGfFMFMTiOTdDVxb
ByJfXc0gszqTpA2mwaMOqlbElNmhRANCAASeItQruBntlJjJYGebdKI9R51AfC1p
4WlWv0NYM5oDTY5yxIarUr6mbOyl6uzvvHjWcVhKp79tCA4v1c40qRHB
-----END PRIVATE KEY-----`

const signMockGatewayToken = (sub: string, role: string, kycTier: number = 0, expiresIn: SignOptions['expiresIn'] = '60s') => {
    const options: SignOptions = { algorithm: 'ES256', expiresIn }
    return jwt.sign(
        {
            iss: 'finvault-gateway',
            aud: 'finvault-internal-services',
            sub,
            role,
            kycTier,
            jti: 'test-jti-' + Date.now()
        },
        DEV_TEST_GATEWAY_PRIVATE_KEY,
        options
    )
}

const createMockReqRes = (headers: Record<string, string> = {}) => {
    const req: any = { headers }
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

console.log('=== TEST THƯ VIỆN FINVAULT-INTERNAL-AUTH (DEV STUB) ===\n')

// 1. Kiểm tra request HỢP LỆ có Gateway Token
{
    const token = signMockGatewayToken('user-123', 'USER', 1)
    const { req, res } = createMockReqRes({ 'x-gateway-token': token })
    let nextCalled = false

    requireGateway(req, res, () => { nextCalled = true })

    console.log('1. Request hợp lệ có x-gateway-token:')
    console.log('   - Cho qua (next called):', nextCalled ? 'PASS' : 'FAIL')
    console.log('   - req.auth được inject đúng userId:', req.auth?.userId === 'user-123' ? 'PASS' : 'FAIL')
    console.log('   - req.auth được inject đúng kycTier:', req.auth?.kycTier === 1 ? 'PASS' : 'FAIL')
}

// 2. Kiểm tra hacker gọi thẳng không có Gateway Token
{
    const { req, res } = createMockReqRes({})
    let nextCalled = false

    requireGateway(req, res, () => { nextCalled = true })

    console.log('\n2. Gọi thẳng service không có Token:')
    console.log('   - Bị từ chối 401:', res.statusCode === 401 ? 'PASS' : 'FAIL')
    console.log('   - Mã lỗi INVALID_GATEWAY_TOKEN:', res.responseData?.error?.code === 'INVALID_GATEWAY_TOKEN' ? 'PASS' : 'FAIL')
}

// 3. Kiểm tra kịch bản giả mạo cờ cũ x-gateway-verified: true (DoD #2)
{
    const { req, res } = createMockReqRes({ 'x-gateway-verified': 'true' })
    let nextCalled = false

    requireGateway(req, res, () => { nextCalled = true })

    console.log('\n3. Kịch bản giả mạo cờ cũ x-gateway-verified: true (DoD #2):')
    console.log('   - Bị từ chối 401 (không bị lừa):', res.statusCode === 401 ? 'PASS' : 'FAIL')
    console.log('   - Không chạy vào controller:', !nextCalled ? 'PASS' : 'FAIL')
}

// 4. Kiểm tra phân quyền RBAC: requireRole('ADMIN')
{
    const userToken = signMockGatewayToken('user-123', 'USER', 0)
    const adminToken = signMockGatewayToken('admin-999', 'ADMIN', 2)

    const userReqRes = createMockReqRes({ 'x-gateway-token': userToken })
    requireGateway(userReqRes.req, userReqRes.res, () => {})
    requireRole('ADMIN')(userReqRes.req, userReqRes.res, () => {})

    console.log('\n4. Phân quyền RBAC:')
    console.log('   - Token USER gọi route ADMIN bị 403 FORBIDDEN:', userReqRes.res.statusCode === 403 ? 'PASS' : 'FAIL')

    const adminReqRes = createMockReqRes({ 'x-gateway-token': adminToken })
    let adminNextCalled = false
    requireGateway(adminReqRes.req, adminReqRes.res, () => {})
    requireRole('ADMIN')(adminReqRes.req, adminReqRes.res, () => { adminNextCalled = true })

    console.log('   - Token ADMIN gọi route ADMIN được cho qua:', adminNextCalled ? 'PASS' : 'FAIL')
}
