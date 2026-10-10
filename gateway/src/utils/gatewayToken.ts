// D:\PTPMHDV\Backend\gateway\src\utils\gatewayToken.ts
import crypto from 'crypto'
import fs from 'fs'
import jwt from 'jsonwebtoken'

/* ==========================================================================
   1. ĐỊNH NGHĨA KIỂU DỮ LIỆU (INTERFACE)
   Chỉ giữ ĐÚNG 1 interface mô tả các thông tin được gói trong Token.
   ========================================================================== */
export interface GatewayPayload {
    iss: string       // Đơn vị phát hành: 'finvault-gateway'
    aud: string       // Nơi nhận: 'finvault-internal-services'
    sub: string       // ID người dùng (userId)
    role: string      // Vai trò: 'USER', 'ADMIN', ...
    kycTier: number   // Cấp độ định danh ví: 0, 1, 2
    jti: string       // Mã định danh token ngẫu nhiên (chống phát lại)
    iat?: number      // Thời điểm sinh token (jwt tự thêm)
    exp?: number      // Thời điểm hết hạn (jwt tự thêm)
}

/* ==========================================================================
   2. KHÓA MẬT MÃ CỐ ĐỊNH (DEV STUB CHO NGÀY 1)
   Cặp khóa ES256 (NIST P-256) dùng để test nhanh nội bộ mà không cần cài đặt.
   ========================================================================== */
export const DEV_STUB_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtGfFMFMTiOTdDVxb
ByJfXc0gszqTpA2mwaMOqlbElNmhRANCAASeItQruBntlJjJYGebdKI9R51AfC1p
4WlWv0NYM5oDTY5yxIarUr6mbOyl6uzvvHjWcVhKp79tCA4v1c40qRHB
-----END PRIVATE KEY-----`

export const DEV_STUB_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEniLUK7gZ7ZSYyWBnm3SiPUedQHwt
aeFpVr9DWDOaA02OcsSGq1K+pmzspers77x41nFYSqe/bQgOL9XONKkRwQ==
-----END PUBLIC KEY-----`

/* ==========================================================================
   3. HÀM HỖ TRỢ ĐỌC KHÓA (HELPER FUNCTIONS)
   Quy tắc: Ưu tiên đọc File Secret -> Biến môi trường -> Dùng khóa Dev Stub
   ========================================================================== */
export const getGatewayPrivateKey = (): string => {
    const keyPath = process.env.GATEWAY_PRIVATE_KEY_FILE
    if (keyPath && fs.existsSync(keyPath)) {
        return fs.readFileSync(keyPath, 'utf-8').trim()
    }

    if (process.env.GATEWAY_PRIVATE_KEY) {
        return process.env.GATEWAY_PRIVATE_KEY.trim()
    }

    return DEV_STUB_PRIVATE_KEY
}

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
   4. HÀM KÝ TOKEN (CHÍNH)
   Nhận trực tiếp 3 tham số, không cần bọc thêm interface trung gian rườm rà.
   ========================================================================== */
export const signGatewayToken = (userId: string, role: string, kycTier: number = 0): string => {
    const payload: GatewayPayload = {
        iss: 'finvault-gateway',
        aud: 'finvault-internal-services',
        sub: userId,
        role,
        kycTier,
        jti: crypto.randomUUID(),
    }

    return jwt.sign(payload, getGatewayPrivateKey(), {
        algorithm: 'ES256',
        expiresIn: '60s',
    })
}

/* ==========================================================================
   5. HÀM KIỂM CHỨNG TOKEN (VERIFY)
   Kiểm tra chữ ký số, hạn dùng 60s và trả về payload đã giải mã.
   ========================================================================== */
export const verifyGatewayToken = (token: string): GatewayPayload => {
    return jwt.verify(token, getGatewayPublicKey(), {
        algorithms: ['ES256'],
        issuer: 'finvault-gateway',
        audience: 'finvault-internal-services',
    }) as GatewayPayload
}
