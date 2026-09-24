import { Request, Response, NextFunction } from 'express'
import { env } from '../config/env'

// Accept only requests verified by the Gateway or authenticated with the internal key.
export const requireGateway = (req: Request, res: Response, next: NextFunction) => {
  const gatewayVerified = req.headers['x-gateway-verified']
  const internalKey = req.headers['x-internal-key']

  if (gatewayVerified === 'true' || (Boolean(env.internalKey) && internalKey === env.internalKey)) {
    return next()
  }

  return res.status(401).json({
    success: false,
    error: {
      code: 'UNAUTHORIZED',
      message: 'Yêu cầu phải được xác thực qua Gateway hoặc internal key'
    }
  })
}