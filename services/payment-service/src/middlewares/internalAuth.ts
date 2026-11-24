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

// Middleware dùng để xác thực các lời gọi Service to Service thông qua X-Internal-Key.
// Người dùng từ bên ngoài sẽ bị từ chối.
export const requireInternalAuth = (req: Request, res: Response, next: NextFunction) => {
    const expectedRaw = process.env.INTERNAL_KEY;

    // 1. Kiểm tra cấu hình hệ thống:
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

    // 2. Kiểm tra Header gửi lên
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

    // 3. Dùng timingSafeEqual để chống timing-attack
    // toán tử === dừng khi gặp ký tự sai đầu tiên, hacker có tính toán thời gian phản hồi để dò từng chữ cái của mật khẩu.
    // Dùng timingSafeEqual để so sánh các byte với thời gian chạy không đổi triệt tiêu nguy cơ.
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

    // Các trường hợp đều pass mở cổng cho qua
    next();
};
