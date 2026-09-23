import { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'crypto'

export interface RequestWithContext extends Request {
  requestId?: string
  userId?: string
  userRole?: string
  isInternalCall?: boolean
  isGatewayVerified?: boolean
}

export function attachRequestId(req: RequestWithContext, res: Response, next: NextFunction) {
  const incomingId = req.headers['x-request-id'] as string
  const requestId = incomingId || randomUUID()
  req.requestId = requestId
  res.setHeader('X-Request-Id', requestId)

  const internalKey = req.headers['x-internal-key'] as string
  req.isInternalCall = Boolean(internalKey && process.env.INTERNAL_KEY && internalKey === process.env.INTERNAL_KEY)
  req.isGatewayVerified = req.headers['x-gateway-verified'] === 'true'

  req.userId = (req.headers['x-user-id'] as string) || (req.headers['user-id'] as string) || undefined
  req.userRole = (req.headers['x-user-role'] as string) || (req.headers['user-role'] as string) || 'USER'

  next()
}
