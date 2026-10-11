import { Response } from 'express'
import { RequestWithContext } from '../middlewares/requestId'
import { prisma } from '../config/prisma'
import { requireAdmin, requireOwner } from '../utils/access'
import { HttpError } from '../utils/errors'
import { findMerchant, register, changeStatus, updateProfile } from '../services/merchant.service'

export async function registerMerchant(req: RequestWithContext, res: Response) {
  const callerId = req.auth?.userId ?? req.internalUserId
  const ownerId = req.isInternalCall ? (req.body.ownerId || callerId) : callerId
  if (!ownerId) throw new HttpError(400, 'OWNER_REQUIRED', 'Owner identity required')
  if (!req.isInternalCall && req.body.ownerId !== undefined && req.body.ownerId !== callerId)
    throw new HttpError(403, 'FORBIDDEN', 'Cannot register for another owner')
  const { businessName, taxId, bankAccount } = req.body
  const merchant = await register({ ownerId, businessName, taxId, bankAccount })
  return res.status(201).json({ success: true, data: merchant })
}
// Identity comes from verified authentication, never a query/body ownerId.
// Explicit null distinguishes no registration from a missing endpoint or server error.
export async function getMyMerchant(req: RequestWithContext, res: Response) {
  const ownerId = req.auth?.userId ?? req.internalUserId
  if (!ownerId) throw new HttpError(401, 'UNAUTHORIZED', 'Authenticated owner required')
  const merchant = await prisma.merchant.findFirst({ where: { ownerId, deletedAt: null } })
  return res.json({ success: true, data: merchant })
}

export async function getMerchantById(req: RequestWithContext, res: Response) {
  const merchant = await findMerchant(String(req.params.id))
  requireOwner(req, merchant.ownerId)
  return res.json({ success: true, data: merchant })
}
export async function updateMerchant(req: RequestWithContext, res: Response) {
  const merchant = await findMerchant(String(req.params.id))
  requireOwner(req, merchant.ownerId)
  const updated = await updateProfile(merchant.id, req.body)
  return res.json({ success: true, data: updated })
}
export async function updateMerchantStatus(req: RequestWithContext, res: Response) {
  requireAdmin(req)
  return res.json({ success: true, data: await changeStatus(String(req.params.id), req.body.status) })
}
export async function checkMerchantActive(req: RequestWithContext, res: Response) {
  // Minimal activity data is available to authenticated callers; bank details are never returned.
  const merchant = await findMerchant(String(req.params.id))
  return res.json({ success: true, data: {
    id: merchant.id, ownerId: merchant.ownerId, businessName: merchant.businessName,
    status: merchant.status, active: merchant.status === 'APPROVED'
  } })
}
export async function getMerchants(req: RequestWithContext, res: Response) {
  requireAdmin(req)
  const { page, limit, search, status } = req.query as unknown as {
    page: number; limit: number; search: string; status?: 'PENDING' | 'APPROVED' | 'REJECTED'
  }
  const where = { deletedAt: null, ...(status ? { status } : {}),
    ...(search ? { businessName: { contains: search, mode: 'insensitive' as const } } : {}) }
  const [content, totalElements] = await Promise.all([
    prisma.merchant.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' } }),
    prisma.merchant.count({ where })
  ])
  return res.json({ success: true, data: { content, page, limit, totalElements, totalPages: Math.max(1, Math.ceil(totalElements / limit)) } })
}
