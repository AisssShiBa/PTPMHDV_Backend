// D:\PTPMHDV\Backend\gateway\test-gateway.ts
import jwt from 'jsonwebtoken'
import { signGatewayToken, verifyGatewayToken } from './src/utils/gatewayToken'
import { authenticate } from './src/middlewares/authenticate'
import { env } from './src/config/services'

console.log('=== TEST 1: KIỂM TRA MODULE MẬT MÃ (ES256) ===')
const userId = '11111111-2222-3333-4444-555555555555'
const role = 'ADMIN'
const kycTier = 2

const token = signGatewayToken(userId, role, kycTier)
const decoded = verifyGatewayToken(token)

console.log('-> Đã ký và verify thành công Token cho:', decoded.sub)
console.log('-> TTL chính xác 60s:', (decoded.exp! - decoded.iat!) === 60 ? 'PASS' : 'FAIL')

console.log('\n=== TEST 2: KIỂM TRA MIDDLEWARE AUTHENTICATE ===')

// Helper giả lập Request, Response và NextFunction của Express
const createMockReqRes = (path: string, method: string, authHeader?: string) => {
    const req: any = {
        path,
        method,
        headers: authHeader ? { authorization: authHeader } : {}
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

// 2.1. Kiểm tra Route công khai: /health
{
    const { req, res } = createMockReqRes('/health', 'GET')
    let nextCalled = false
    authenticate(req, res, () => { nextCalled = true })

    console.log('1. Route công khai (/health):')
    console.log('   - Cho qua (next called):', nextCalled ? 'PASS' : 'FAIL')
    console.log('   - KHÔNG còn cờ x-gateway-verified:', req.headers['x-gateway-verified'] === undefined ? 'PASS' : 'FAIL')
}

// 2.2. Kiểm tra Route bảo vệ nhưng KHÔNG có Token: /api/wallets/me
{
    const { req, res } = createMockReqRes('/api/wallets/me', 'GET')
    authenticate(req, res, () => {})

    console.log('2. Route bảo vệ thiếu token:')
    console.log('   - Chặn với status 401:', res.statusCode === 401 ? 'PASS' : 'FAIL')
    console.log('   - Mã lỗi UNAUTHORIZED:', res.responseData?.error?.code === 'UNAUTHORIZED' ? 'PASS' : 'FAIL')
}

// 2.3. Kiểm tra Route bảo vệ với Access Token Client hợp lệ: /api/wallets/me
{
    // Tạo client token giả lập bằng ACCESS_TOKEN_SECRET
    const clientToken = jwt.sign(
        { userId, role, kycTier },
        env.accessTokenSecret,
        { expiresIn: '15m' }
    )

    const { req, res } = createMockReqRes('/api/wallets/me', 'GET', `Bearer ${clientToken}`)
    let nextCalled = false
    authenticate(req, res, () => { nextCalled = true })

    console.log('3. Route bảo vệ có Client Token hợp lệ:')
    console.log('   - Xác thực thành công (next called):', nextCalled ? 'PASS' : 'FAIL')
    console.log('   - Đã sinh header x-gateway-token:', typeof req.headers['x-gateway-token'] === 'string' ? 'PASS' : 'FAIL')
    console.log('   - Đã xóa triệt để cờ x-gateway-verified:', req.headers['x-gateway-verified'] === undefined ? 'PASS' : 'FAIL')

    // Giải mã kiểm chứng x-gateway-token được sinh ra
    const verifiedGatewayPayload = verifyGatewayToken(req.headers['x-gateway-token'])
    console.log('   - Gateway Token giải mã đúng userId:', verifiedGatewayPayload.sub === userId ? 'PASS' : 'FAIL')
    console.log('   - Gateway Token giải mã đúng kycTier:', verifiedGatewayPayload.kycTier === kycTier ? 'PASS' : 'FAIL')
}
