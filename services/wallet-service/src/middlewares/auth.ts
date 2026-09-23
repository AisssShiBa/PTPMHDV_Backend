import { Request, Response, NextFunction } from 'express';

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  const internalKey = req.headers['x-internal-key'];
  const expectedKey = process.env.INTERNAL_KEY;

  if (!expectedKey) {
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'INTERNAL_KEY is not configured',
      },
    });
  }

  const gatewayVerified = req.headers['x-gateway-verified'];

  // Nếu là request từ API Gateway đã được xác thực
  if (gatewayVerified === 'true') {
    return next();
  }

  // Nếu là request nội bộ (Service gọi Service)
  if (!internalKey || internalKey !== expectedKey) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing authentication',
      },
    });
  }

  next();
};
