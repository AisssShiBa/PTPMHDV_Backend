// requestId.ts — chỉ đảm nhiệm gán request ID và đánh dấu loại request.
// userId/role KHÔNG được đọc từ header nữa; sau khi requireGateway chạy xong,
// controller dùng req.auth.userId và req.auth.role trực tiếp.

import { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'crypto'

export interface RequestWithContext extends Request {
    requestId?: string
    isInternalCall?: boolean
}

export function attachRequestId(req: RequestWithContext, res: Response, next: NextFunction) {
    const incomingId = req.headers['x-request-id'] as string
    const requestId  = incomingId || randomUUID()
    req.requestId    = requestId
    res.setHeader('X-Request-Id', requestId)

    // isInternalCall đã được set bởi requireGatewayOrInternalKey (Luồng B).
    // Nếu middleware đó chưa chạy, mặc định là false.
    if (req.isInternalCall === undefined) {
        req.isInternalCall = false
    }

    next()
}
