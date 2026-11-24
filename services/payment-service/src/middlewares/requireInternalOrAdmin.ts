import { Request, Response, NextFunction } from 'express';

/*
    1. Nếu dùng x-internal-key (Service nội bộ)
        => Cho qua.
    2. Nếu quản trị viên (role = ADMIN).
        => Cho qua.
    3. Người dùng thông thường bị chặn.
*/ 
export const requireInternalOrAdmin = (req: Request, res: Response, next: NextFunction) => {
    if ((req as any).isInternalCall) {
        return next();
    }

    if ((req as any).auth?.role === 'ADMIN') {
        return next();
    }

    return res.status(403).json({
        success: false,
        error: {
            code: 'FORBIDDEN',
            message: 'You are not authorized to perform this action. Requires INTERNAL or ADMIN.',
        },
    });
};
