import { RequestWithContext } from '../middlewares/requestId'
import { HttpError } from './errors'

export function requireAdmin(req: RequestWithContext) {
  if (!req.isInternalCall && req.auth?.role !== 'ADMIN') throw new HttpError(403, 'FORBIDDEN', 'Administrator access required')
}
// Both sides are Auth IDs, never merchant or local profile IDs.
export function requireOwner(req: RequestWithContext, ownerAuthUserId: string) {
  if (!req.isInternalCall && req.auth?.role !== 'ADMIN' && req.auth?.userId !== ownerAuthUserId)
    throw new HttpError(403, 'FORBIDDEN', 'You cannot access this resource')
}
