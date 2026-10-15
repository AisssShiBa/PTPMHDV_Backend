import { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'node:crypto'

export interface RequestWithContext extends Request {
  requestId?: string
  // Auth ID from a verified internal request, not the local profile ID.
  internalUserId?: string
  isInternalCall?: boolean
}
export function attachRequestId(req: RequestWithContext, res: Response, next: NextFunction) {
  const incoming = req.get('x-request-id')
  req.requestId = incoming && /^[a-zA-Z0-9_-]{1,100}$/.test(incoming) ? incoming : randomUUID()
  res.setHeader('X-Request-Id', req.requestId)
  // Identity is assigned only after authentication, never from unverified headers.
  next()
}
