import { Request, Response, NextFunction } from 'express';

export const requireGateway = (req: Request, res: Response, next: NextFunction) => {
  const gatewayVerified = req.headers['x-gateway-verified'];
  const internalKey = req.headers['x-internal-key'];
  const expectedKey = process.env.INTERNAL_KEY;

  // Nếu request đi qua API Gateway
  if (gatewayVerified === 'true') {
    return next();
  }

  // Nếu request gọi trực tiếp từ một microservice nội bộ khác
  if (expectedKey && internalKey === expectedKey) {
    return next();
  }

  return res.status(401).json({
    success: false,
    error: {
      code: 'UNAUTHORIZED',
      message: 'Direct access to this service is forbidden. Request must pass through API Gateway or use valid internal key.',
    },
  });
};
