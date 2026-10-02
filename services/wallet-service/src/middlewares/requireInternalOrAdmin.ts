import { Response, NextFunction } from 'express';
import { RequestWithContext } from './requestId';

export const requireInternalOrAdmin = (req: RequestWithContext, res: Response, next: NextFunction) => {
  if (req.isInternalCall) {
    return next();
  }

  if (req.userRole === 'ADMIN') {
    return next();
  }

  return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You are not authorized to perform this action. Requires INTERNAL or ADMIN.' } });
};
