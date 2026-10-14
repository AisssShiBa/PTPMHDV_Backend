import { Request, Response, NextFunction } from 'express'
import { requireGateway } from 'finvault-internal-auth'

// Preserve the controllers' self-access checks using only verified Gateway claims.
export const clientAuth = (req: Request, res: Response, next: NextFunction) => {
  req.userId = undefined
  return requireGateway(req, res, () => {
    req.userId = req.auth!.userId
    next()
  })
}
