import { Response, NextFunction } from 'express'
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { requireGateway } from 'finvault-internal-auth'
import { env } from '../config/env'
import { HttpError } from '../utils/errors'
import { RequestWithContext } from './requestId'

// Auth/Admin retain authenticated internal calls; Gateway strips client internal keys.
export function authenticateServiceRequest(req: RequestWithContext, res: Response, next: NextFunction) {
  req.auth = undefined
  req.isInternalCall = false
  req.internalUserId = undefined
  const internal = req.get('x-internal-key')
  if (internal === undefined) return requireGateway(req, res, next)
  try {
    const supplied = Buffer.from(internal)
    const expected = Buffer.from(env.internalKey)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new HttpError(401, 'UNAUTHORIZED', 'Invalid internal credentials')
    const userId = req.get('x-user-id')
    if (userId) {
      const parsed = z.string().uuid().safeParse(userId)
      if (!parsed.success) throw new HttpError(401, 'UNAUTHORIZED', 'Invalid internal identity')
      req.internalUserId = parsed.data
    }
    req.isInternalCall = true
    return next()
  } catch (error) { return next(error) }
}
