import { Response, NextFunction } from 'express'
import { RequestWithContext } from './requestId'
import { requireGateway as verifyGateway, getGatewayPublicKey } from 'finvault-internal-auth'

getGatewayPublicKey()

export function requireGateway(req: RequestWithContext, res: Response, next: NextFunction) {
  req.auth = undefined
  if (req.isInternalCall) return next()
  req.userId = undefined
  req.userRole = undefined
  req.isGatewayVerified = false
  return verifyGateway(req, res, () => {
    // Adapter for existing Admin controllers; identity comes only from signed claims.
    req.userId = req.auth!.userId
    req.userRole = req.auth!.role
    req.isGatewayVerified = true
    next()
  })
}
