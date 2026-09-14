import { Request, Response, NextFunction } from 'express';

export const requireInternalAuth = (req: Request, res: Response, next: NextFunction) => {
  const internalKey = req.headers['x-internal-key'];
  const expectedKey = process.env.INTERNAL_KEY || process.env.INTERNAL_API_KEY;

  if (!expectedKey) {
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'INTERNAL_API_KEY is not configured',
      },
    });
  }

  if (!internalKey || internalKey !== expectedKey) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing X-Internal-Key',
      },
    });
  }

  next();
};
