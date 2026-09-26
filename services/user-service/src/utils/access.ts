import { RequestWithContext } from '../middlewares/requestId'
import { HttpError } from './errors'

export function requireAdmin(req: RequestWithContext) {
  if (!req.isInternalCall && req.userRole !== 'ADMIN') throw new HttpError(403, 'FORBIDDEN', 'Administrator access required')
}
export function requireOwner(req: RequestWithContext, ownerId: string) {
  if (!req.isInternalCall && req.userRole !== 'ADMIN' && req.userId !== ownerId)
    throw new HttpError(403, 'FORBIDDEN', 'You cannot access this resource')
}
