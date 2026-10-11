// requireInternalOrAdmin.ts
// Chỉ cho phép:
//   - Call nội bộ từ service (isInternalCall = true)  ← được set bởi requireGatewayOrInternalKey
//   - User có role ADMIN đi qua Gateway               ← đọc từ req.auth.role

import { Response, NextFunction } from 'express'
import { RequestWithContext } from './requestId'

export const requireInternalOrAdmin = (req: RequestWithContext, res: Response, next: NextFunction) => {
    if (req.isInternalCall) {
        return next()
    }

    // req.auth được inject bởi requireGateway (ES256 verified)
    if (req.auth?.role === 'ADMIN') {
        return next()
    }

    return res.status(403).json({
        success: false,
        error: {
            code: 'FORBIDDEN',
            message: 'You are not authorized to perform this action. Requires INTERNAL or ADMIN.',
        },
    })
}
