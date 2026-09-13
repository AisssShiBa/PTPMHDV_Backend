import { Request, Response, NextFunction } from 'express'
import { fail } from '../utils/response'

export const requireRole = (...allowedRoles: string[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
        const role = req.headers['x-user-role'] as string
        if (!role || !allowedRoles.includes(role)) {
            return fail(res, 403, 'FORBIDDEN', 'Bạn không có quyền truy cập tài nguyên này')
        }
        next()
    }
}