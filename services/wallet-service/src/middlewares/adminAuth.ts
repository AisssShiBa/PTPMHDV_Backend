import { Request, Response, NextFunction } from 'express';

export const requireAdminAuth = (req: Request, res: Response, next: NextFunction) => {
  const internalKey = req.headers['x-internal-key'];
  const expectedKey = process.env.INTERNAL_KEY;
  const gatewayVerified = req.headers['x-gateway-verified'];
  const userRole = req.headers['x-user-role'];
  const userId = req.headers['x-user-id'];

  // 1. Ưu tiên kiểm tra request từ Gateway trước
  if (gatewayVerified === 'true' && userId && userRole === 'ADMIN') {
    if (req.body) {
      req.body.adminId = userId;
    }
    return next();
  }

  // 2. Nếu không đủ điều kiện từ Gateway, kiểm tra Internal Key (gọi nội bộ)
  if (expectedKey && internalKey === expectedKey) {
    return next();
  }

  // 3. Nếu thiếu cả 2 -> Từ chối truy cập
  return res.status(401).json({
    success: false,
    error: {
      code: 'UNAUTHORIZED',
      message: 'Invalid or missing admin authentication',
    },
  });
};
