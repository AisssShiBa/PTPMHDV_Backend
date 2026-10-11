// internalAuth.ts — Xác thực request service-to-service nội bộ
//
// Chỉ dùng cho các endpoint KHÔNG có user context (VD: confirm/refund
// được gọi từ một service nội bộ khác sau khi xử lý payment).
//
// Cơ chế: So sánh header x-internal-key với biến môi trường INTERNAL_KEY
// bằng crypto.timingSafeEqual để chống timing-attack.
//
// Fail-closed: Nếu INTERNAL_KEY chưa cấu hình → 500 (không im lặng cho qua).

import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';

export const requireInternalAuth = (req: Request, res: Response, next: NextFunction) => {
    const expectedRaw = process.env.INTERNAL_KEY;

    // Fail-closed: biến môi trường chưa được cấu hình
    if (!expectedRaw) {
        return res.status(500).json({
            success: false,
            error: {
                code: 'INTERNAL_SERVER_ERROR',
                message: 'INTERNAL_KEY is not configured on this service.',
            },
        });
    }

    const provided = req.headers['x-internal-key'];

    if (!provided || typeof provided !== 'string') {
        return res.status(401).json({
            success: false,
            error: {
                code: 'UNAUTHORIZED',
                message: 'Missing X-Internal-Key header.',
            },
        });
    }

    // Dùng timingSafeEqual để chống timing-attack
    let isValid = false;
    try {
        const expected = Buffer.from(expectedRaw, 'utf-8');
        const actual   = Buffer.from(provided,     'utf-8');
        isValid = expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch {
        isValid = false;
    }

    if (!isValid) {
        return res.status(401).json({
            success: false,
            error: {
                code: 'UNAUTHORIZED',
                message: 'Invalid X-Internal-Key.',
            },
        });
    }

    next();
};
