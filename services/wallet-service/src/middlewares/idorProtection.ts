import { Request, Response, NextFunction } from 'express';

// Lấy userId từ header đè lên body (nếu có) để chống IDOR
export const protectIdorBody = (req: Request, res: Response, next: NextFunction) => {
  if (req.headers['x-gateway-verified'] === 'true' && req.headers['x-user-id']) {
    const gatewayUserId = req.headers['x-user-id'] as string;
    if (req.body && req.body.userId) {
      req.body.userId = gatewayUserId;
    }
  }
  next();
};

// Lấy userId từ header đè lên param trên URL để chống IDOR
export const protectIdorParam = (req: Request, res: Response, next: NextFunction, id: string) => {
  if (req.headers['x-gateway-verified'] === 'true' && req.headers['x-user-id']) {
    req.params.userId = req.headers['x-user-id'] as string;
  }
  next();
};
