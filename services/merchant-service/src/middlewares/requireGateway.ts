import { Response, NextFunction } from 'express'
import { RequestWithContext } from './requestId'

export function requireGateway(req: RequestWithContext, res: Response, next: NextFunction) {
  const disableCheck = process.env.NODE_ENV !== 'production' && process.env.DISABLE_GATEWAY_CHECK === 'true'


  if (disableCheck || req.isGatewayVerified || req.isInternalCall) {
    return next()
  }

  return res.status(403).json({
    success: false,
    error: {
      code: 'FORBIDDEN',
      message: 'Access denied: Requests must be routed through API Gateway or provide valid internal service credentials'
    }
  })
}
