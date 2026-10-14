// Middleware dùng cho các route wallet cần hỗ trợ CẢ HAI luồng:
//   1. Request từ người dùng đi qua API Gateway  → xác thực bằng x-gateway-token (ES256)
//   2. Request service-to-service nội bộ         → xác thực bằng INTERNAL_KEY (timingSafeEqual)
//
// Lưu ý: KHÔNG còn nhánh nào tin header `x-gateway-verified` do client tự gán.

import { Request, Response, NextFunction } from 'express'
import { timingSafeEqual } from 'crypto'
import { requireGateway, verifyGatewayToken } from 'finvault-internal-auth'

/**
 * Kiểm tra INTERNAL_KEY an toàn.
 * Fail-closed: nếu biến môi trường INTERNAL_KEY chưa được cấu hình,
 * request nội bộ sẽ bị từ chối thay vì bị cho qua (tránh lỗi config im lặng).
 */
function isValidInternalKey(provided: string | string[] | undefined): boolean {
    const expectedRaw = process.env.INTERNAL_KEY
    if (!expectedRaw) {
        // Fail-closed: INTERNAL_KEY chưa cấu hình → không cho qua
        return false
    }
    if (!provided || typeof provided !== 'string') return false

    try {
        const expected = Buffer.from(expectedRaw, 'utf-8')
        const actual   = Buffer.from(provided,     'utf-8')
        if (expected.length !== actual.length) return false
        return timingSafeEqual(expected, actual)
    } catch {
        return false
    }
}

/**
 * requireGatewayOrInternalKey
 *
 * Luồng xử lý:
 *   A. Có header `x-gateway-token`  → Xác thực ES256 qua finvault-internal-auth.
 *      Kết quả hợp lệ được inject vào `req.auth` bởi thư viện.
 *   B. Có header `x-internal-key`   → So sánh timingSafeEqual với INTERNAL_KEY env.
 *      Gán `req.isInternalCall = true`; req.auth KHÔNG được set (không có user context).
 *   C. Không có cả hai             → 401.
 */
export const requireGatewayOrInternalKey = (
    req: Request,
    res: Response,
    next: NextFunction
): void | Response => {
    const rawToken   = req.headers['x-gateway-token']
    const internalKey = req.headers['x-internal-key']

    // --- Luồng A: Gateway Token ---
    if (rawToken && typeof rawToken === 'string') {
        // Delegate hoàn toàn cho requireGateway của package (verify ES256, iss, aud, TTL)
        // Cast to any giải quyết dual @types/express version mismatch (package vs service)
        return (requireGateway as any)(req, res, next)
    }

    // --- Luồng B: Internal Service Key ---
    if (isValidInternalKey(internalKey)) {
        // Đánh dấu đây là call nội bộ để các middleware downstream xử lý phù hợp
        ;(req as any).isInternalCall = true
        return next()
    }

    // --- Luồng C: Không có credential hợp lệ ---
    return res.status(401).json({
        success: false,
        error: {
            code: 'UNAUTHORIZED',
            message: 'Yêu cầu phải được xác thực qua API Gateway (x-gateway-token) hoặc Internal Key (x-internal-key).',
        },
    })
}
