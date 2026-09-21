import { Request, Response, NextFunction } from 'express';

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  const headerUserId = req.headers['x-user-id'] as string;
  
  if (!headerUserId) {
    return res.status(401).json({ 
      success: false, 
      error: { code: 'UNAUTHORIZED', message: 'Missing x-user-id header' } 
    });
  }

  // Lưu userId vào biến của req để không bị mất khi qua bước validate
  (req as any).userId = headerUserId;

  next();
};
