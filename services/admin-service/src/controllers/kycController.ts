import { Request, Response } from 'express'
import { KycActions } from '../services/kycActions'
import { createError } from '../middlewares/errorHandler'

function context(req: Request) {
  const userId = String(req.params.userId)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId))
    throw createError(400, 'VALIDATION_ERROR', 'userId must be a UUID')
  if (!req.auth || req.auth.role !== 'ADMIN') throw createError(403, 'FORBIDDEN', 'Administrator access required')
  return { userId, adminId: req.auth.userId, requestId: (req as Request & { requestId?: string }).requestId || 'unknown' }
}
function reason(value: unknown, required: boolean) {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 500)
    throw createError(400, 'VALIDATION_ERROR', 'reason must contain 1 to 500 characters')
  return value.trim()
}
export async function reviewKyc(req: Request, res: Response) {
  const { userId, adminId, requestId } = context(req)
  const { status, detail } = req.body || {}
  if (status !== 'APPROVED' && status !== 'REJECTED')
    throw createError(400, 'INVALID_STATUS', 'Only APPROVED or REJECTED is accepted')
  return res.json(await KycActions.review(userId, status, reason(detail, false), adminId, requestId))
}
export async function changeKycTier(req: Request, res: Response) {
  const { userId, adminId, requestId } = context(req)
  const { tier, reason: inputReason, ...extra } = req.body || {}
  if ((tier !== 1 && tier !== 2) || Object.keys(extra).length)
    throw createError(400, 'VALIDATION_ERROR', 'Expected tier 1 or 2 and reason')
  return res.json(await KycActions.changeTier(userId, tier, reason(inputReason, true)!, adminId, requestId))
}
export async function getKycDocuments(req: Request, res: Response) {
  const { userId, adminId, requestId } = context(req)
  res.setHeader('Cache-Control', 'no-store')
  return res.json(await KycActions.documents(userId, adminId, requestId))
}
