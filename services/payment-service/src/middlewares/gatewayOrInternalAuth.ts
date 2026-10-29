// Middleware dùng cho các route payment cần hỗ trợ CẢ HAI luồng:
//   1. Request từ người dùng đi qua API Gateway  → xác thực bằng x-gateway-token (ES256)
//   2. Request service-to-service nội bộ         → xác thực bằng INTERNAL_KEY (timingSafeEqual)

import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { requireGateway } from 'finvault-internal-auth';

/**
 * Kiểm tra INTERNAL_KEY an toàn.
 * Fail-closed: nếu biến môi trường INTERNAL_KEY chưa được cấu hình,
 * request nội bộ sẽ bị từ chối thay vì bị cho qua.
 */
function isValidInternalKey(provided: string | string[] | undefined): boolean {
    const expectedRaw = process.env.INTERNAL_KEY;
    if (!expectedRaw) {
        return false;
    }
    if (!provided || typeof provided !== 'string') return false;

    try {
        const expected = Buffer.from(expectedRaw, 'utf-8');
        const actual   = Buffer.from(provided,     'utf-8');
        if (expected.length !== actual.length) return false;
        return timingSafeEqual(expected, actual);
    } catch {
        return false;
    }
}

/**
 * requireGatewayOrInternalKey
 *
 * Luồng xử lý:
 *   A. Có header `x-gateway-token`  → Xác thực ES256 qua finvault-internal-auth.
 *      Kết quả hợp lệ được inject vào `req.auth` bởi thư viện.
 *   B. Có header `x-internal-key`   → So sánh timingSafeEqual với INTERNAL_KEY env.
 *      Gán `req.isInternalCall = true`; req.auth không được set.
 *   C. Không có cả hai             → 401 Unauthorized.
 */
export const requireGatewayOrInternalKey = (
    req: Request,
    res: Response,
    next: NextFunction
): void | Response => {
    const rawToken    = req.headers['x-gateway-token'];
    const internalKey = req.headers['x-internal-key'];

    // --- Luồng A: Gateway Token (Client gọi qua Gateway với Bearer token) ---
    if (rawToken && typeof rawToken === 'string') {
        return (requireGateway as any)(req, res, next);
    }

    // --- Luồng B: Internal Service Key ---
    if (isValidInternalKey(internalKey)) {
        (req as any).isInternalCall = true;
        return next();
    }

    // --- Luồng C: Không có credential hợp lệ ---
    return res.status(401).json({
        success: false,
        error: {
            code: 'UNAUTHORIZED',
            message: 'Yêu cầu phải được xác thực qua API Gateway (Bearer token) hoặc Internal Key (x-internal-key).',
        },
    });
};

