// requireOwnerOrAdmin.ts
// Đảm bảo người dùng chỉ có thể tác động lên ví của chính mình, trừ khi là ADMIN
// hoặc là call nội bộ từ service (isInternalCall = true).
//
// Đọc userId và role từ req.auth (do requireGateway inject), KHÔNG đọc từ header.

import { Request, Response, NextFunction } from 'express'
import { RequestWithContext } from './requestId'

export const requireOwnerOrAdmin = (req: RequestWithContext, res: Response, next: NextFunction) => {
    // Call nội bộ từ service (payment-service → wallet-service), cho phép qua
    if (req.isInternalCall) {
        return next()
    }

    // Đọc danh tính từ req.auth (đã được requireGateway verify bằng ES256)
    const auth = req.auth
    if (!auth) {
        return res.status(401).json({
            success: false,
            error: { code: 'UNAUTHORIZED', message: 'Missing authentication context' },
        })
    }

    const requesterId = auth.userId
    const requesterRole = auth.role

    // Lấy target userId từ params hoặc body
    const targetUserId = req.params.userId || (req.body && req.body.userId)

    if (targetUserId && requesterId !== targetUserId && requesterRole !== 'ADMIN') {
        return res.status(403).json({
            success: false,
            error: { code: 'FORBIDDEN', message: 'You are not authorized to perform this action' },
        })
    }

    next()
}
