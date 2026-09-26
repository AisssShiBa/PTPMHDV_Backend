import { Response, NextFunction } from 'express';
import { RequestWithContext } from './requestId';

export const requireOwnerOrAdmin = (req: RequestWithContext, res: Response, next: NextFunction) => {
  // If it's an internal call, allow it (e.g. payment-service calling wallet-service)
  if (req.isInternalCall) {
    return next();
  }

  const requesterId = req.userId;
  const requesterRole = req.userRole;
  
  // Get target user id from params or body
  const targetUserId = req.params.userId || (req.body && req.body.userId);
  
  if (!requesterId) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Missing user context' } });
  }

  if (targetUserId && requesterId !== targetUserId && requesterRole !== 'ADMIN') {
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You are not authorized to perform this action' } });
  }

  next();
};
