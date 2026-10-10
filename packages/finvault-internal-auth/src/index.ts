// D:\PTPMHDV\Backend\packages\finvault-internal-auth\src\index.ts
import fs from 'fs'
import jwt, { VerifyOptions, SignOptions } from 'jsonwebtoken'
import { Request, Response, NextFunction } from 'express'

/* ==========================================================================
   1. ĐỊNH NGHĨA KIỂU DỮ LIỆU & MỞ RỘNG EXPRESS REQUEST
   Định nghĩa ngữ cảnh người dùng gắn vào req.auth cho mọi microservice.
   ========================================================================== */
export interface GatewayAuthContext {
    userId: string
    role: string
    kycTier: number
    jti: string
}

interface RawGatewayClaims {
    iss: string
    aud: string
    sub: string
    role: string
    kycTier?: number
    jti: string
    iat?: number
    exp?: number
}

// Khai báo mở rộng Request của Express để hỗ trợ thuộc tính req.auth có type chuẩn
declare global {
    namespace Express {
        interface Request {
            auth?: GatewayAuthContext
        }
    }
}

/* ==========================================================================
   2. KHÓA CÔNG KHAI CỐ ĐỊNH (DEV STUB CHO NGÀY 1)
   Các service con CHỈ GIỮ Public Key này để kiểm chứng, TUYỆT ĐỐI không có Private Key.
   ========================================================================== */
export const DEV_STUB_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEniLUK7gZ7ZSYyWBnm3SiPUedQHwt
aeFpVr9DWDOaA02OcsSGq1K+pmzspers77x41nFYSqe/bQgOL9XONKkRwQ==
-----END PUBLIC KEY-----`

// Khóa riêng mẫu CHỈ dùng nội bộ cho hàm helper sinh token trong môi trường TEST
export const DEV_STUB_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtGfFMFMTiOTdDVxb
ByJfXc0gszqTpA2mwaMOqlbElNmhRANCAASeItQruBntlJjJYGebdKI9R51AfC1p
4WlWv0NYM5oDTY5yxIarUr6mbOyl6uzvvHjWcVhKp79tCA4v1c40qRHB
-----END PRIVATE KEY-----`

/* ==========================================================================
   3. HÀM TẢI KHÓA CÔNG KHAI
   Ưu tiên: Docker Secret (_FILE) -> Biến môi trường -> Khóa Dev Stub
   ========================================================================== */
export const getGatewayPublicKey = (): string => {
    const keyPath = process.env.GATEWAY_PUBLIC_KEY_FILE
    if (keyPath && fs.existsSync(keyPath)) {
        return fs.readFileSync(keyPath, 'utf-8').trim()
    }

    if (process.env.GATEWAY_PUBLIC_KEY) {
        return process.env.GATEWAY_PUBLIC_KEY.trim()
    }

    return DEV_STUB_PUBLIC_KEY
}

/* ==========================================================================
   4. HÀM XÁC THỰC TRỰC TIẾP GATEWAY TOKEN (DÙNG CHO WEBSOCKET / UTILS)
   Kiểm tra chữ ký số ES256, đơn vị phát hành (iss), đối tượng nhận (aud), và TTL 60s.
   ========================================================================== */
export const verifyGatewayToken = (token: string): GatewayAuthContext => {
    const publicKey = getGatewayPublicKey()

    const options: VerifyOptions = {
        algorithms: ['ES256'],
        issuer: 'finvault-gateway',
        audience: 'finvault-internal-services',
    }

    const decoded = jwt.verify(token, publicKey, options) as RawGatewayClaims

    return {
        userId: decoded.sub,
        role: decoded.role,
        kycTier: decoded.kycTier ?? 0,
        jti: decoded.jti,
    }
}

/* ==========================================================================
   5. MIDDLEWARE REQUIRE GATEWAY (CHÍNH CHO TOÀN BỘ MICROSERVICES)
   Mọi route nội bộ cần bảo vệ đều đặt middleware này ở đầu:
   app.use(requireGateway)
   ========================================================================== */
export const requireGateway = (req: Request, res: Response, next: NextFunction): void | Response => {
    // 1. Lấy token từ header nội bộ do Gateway chuyển tiếp sang
    const rawToken = req.headers['x-gateway-token']

    if (!rawToken || typeof rawToken !== 'string') {
        return res.status(401).json({
            success: false,
            error: {
                code: 'INVALID_GATEWAY_TOKEN',
                message: 'Truy cập bị từ chối: Yêu cầu bắt buộc phải được định tuyến qua API Gateway có Gateway Token hợp lệ.',
            },
        })
    }

    try {
        // 2. Xác thực chữ ký số bằng Public Key của Gateway
        const authContext = verifyGatewayToken(rawToken)

        // 3. Inject thông tin đã xác thực vào req.auth để controller phía sau sử dụng
        req.auth = authContext

        return next()
    } catch (error) {
        // Token sai chữ ký, hết hạn 60s, hoặc sai issuer/audience
        return res.status(401).json({
            success: false,
            error: {
                code: 'INVALID_GATEWAY_TOKEN',
                message: 'Gateway Token không hợp lệ hoặc đã hết hạn.',
            },
        })
    }
}

/* ==========================================================================
   6. MIDDLEWARE KIỂM TRA PHÂN QUYỀN VAI TRÒ (RBAC HELPER)
   Ví dụ dùng trong admin-service: app.use(requireRole('ADMIN'))
   ========================================================================== */
export const requireRole = (requiredRole: string) => {
    return (req: Request, res: Response, next: NextFunction): void | Response => {
        if (!req.auth) {
            return res.status(401).json({
                success: false,
                error: {
                    code: 'UNAUTHORIZED',
                    message: 'Bạn chưa được xác thực danh tính.',
                },
            })
        }

        if (req.auth.role !== requiredRole) {
            return res.status(403).json({
                success: false,
                error: {
                    code: 'FORBIDDEN',
                    message: `Từ chối quyền truy cập: Bạn cần vai trò [${requiredRole}] để thực hiện thao tác này.`,
                },
            })
        }

        return next()
    }
}

/* ==========================================================================
   7. HÀM HELPER HỖ TRỢ VIẾT INTEGRATION TESTS TRONG CÁC SERVICE
   Giúp Khoa, Hữu, Nguyên dễ dàng sinh x-gateway-token hợp lệ trong file test.
   ========================================================================== */
export const createTestGatewayToken = (
    userId: string,
    role: string = 'USER',
    kycTier: number = 0,
    expiresIn: SignOptions['expiresIn'] = '60s'
): string => {
    const payload = {
        iss: 'finvault-gateway',
        aud: 'finvault-internal-services',
        sub: userId,
        role,
        kycTier,
        jti: 'test-jti-' + Date.now(),
    }
    const options: SignOptions = { algorithm: 'ES256', expiresIn }
    return jwt.sign(payload, DEV_STUB_PRIVATE_KEY, options)
}
