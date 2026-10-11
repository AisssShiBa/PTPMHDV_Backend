// requestId.ts — chỉ gán request ID để truy vết log xuyên suốt hệ thống.
// userId/role KHÔNG được đọc từ header nữa; controller dùng req.auth.userId
// và req.auth.role trực tiếp (được inject bởi requireGateway sau khi verify ES256).

import { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'crypto'

export interface RequestWithContext extends Request {
    requestId?: string
}

export function attachRequestId(req: RequestWithContext, res: Response, next: NextFunction) {
    const incomingId = req.headers['x-request-id'] as string
    const requestId  = incomingId || randomUUID()
    req.requestId    = requestId
    res.setHeader('X-Request-Id', requestId)
    next()
}
