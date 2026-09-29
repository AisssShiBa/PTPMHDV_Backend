import { Response, NextFunction } from 'express'
import { timingSafeEqual } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { env } from '../config/env'
import { HttpError } from '../utils/errors'
import { RequestWithContext } from './requestId'

const identity = z.object({ userId: z.string().uuid(), role: z.enum(['USER', 'ADMIN', 'MERCHANT']) })
export function requireGateway(req: RequestWithContext, _res: Response, next: NextFunction) {
  try {
    req.isInternalCall = false
    req.isGatewayVerified = false
    req.userId = undefined
    req.userRole = undefined
    const internal = req.get('x-internal-key')
    if (internal !== undefined) {
      const supplied = Buffer.from(internal)
      const expected = Buffer.from(env.internalKey)
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        throw new HttpError(401, 'UNAUTHORIZED', 'Invalid internal credentials')
      req.isInternalCall = true
      const userId = req.get('x-user-id')
      if (userId) req.userId = z.string().uuid().parse(userId)
      return next()
    }
    if (!env.disableGatewayCheck && req.get('x-gateway-verified') !== 'true')
      throw new HttpError(403, 'FORBIDDEN', 'Request must pass through the gateway')
    const authorization = req.get('authorization')
    if (!authorization?.startsWith('Bearer '))
      throw new HttpError(401, 'UNAUTHORIZED', 'Bearer token required')
    let claims
    try {
      claims = identity.parse(jwt.verify(authorization.slice(7), env.accessTokenSecret, { algorithms: ['HS256'] }))
    } catch {
      throw new HttpError(401, 'INVALID_TOKEN', 'Invalid or expired token')
    }
    req.userId = claims.userId
    req.userRole = claims.role
    req.isGatewayVerified = true
    next()
  } catch (error) { next(error) }
}
