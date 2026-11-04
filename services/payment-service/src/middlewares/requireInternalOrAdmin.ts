import { Request, Response, NextFunction } from 'express';

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
