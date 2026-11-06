import { Response } from 'express'
import { RequestWithContext } from '../middlewares/requestId'
import { prisma } from '../config/prisma'
import { requireAdmin, requireOwner } from '../utils/access'
import { HttpError } from '../utils/errors'
import { findMerchantById, register, changeStatus, updateProfile } from '../services/merchant.service'
import { createOutlet, listOutlets, getOutletQr } from '../services/outlet.service'
import { issueApiKey, revokeApiKey } from '../services/merchant-api-key.service'

export async function registerMerchant(req: RequestWithContext, res: Response) {
  const callerAuthUserId = req.auth?.userId ?? req.internalUserId
  const ownerAuthUserId = req.isInternalCall ? (req.body.ownerId || callerAuthUserId) : callerAuthUserId
  if (!ownerAuthUserId) throw new HttpError(400, 'OWNER_REQUIRED', 'Owner identity required')
  if (!req.isInternalCall && req.body.ownerId !== undefined && req.body.ownerId !== callerAuthUserId)
    throw new HttpError(403, 'FORBIDDEN', 'Cannot register for another owner')
  const { businessName, taxId, bankAccount } = req.body
  const merchant = await register({ ownerId: ownerAuthUserId, businessName, taxId, bankAccount })
  return res.status(201).json({ success: true, message: 'Success', data: merchant })
}
// Identity comes from verified authentication, never a query/body ownerId.
// Explicit null distinguishes no registration from a missing endpoint or server error.
export async function getMyMerchant(req: RequestWithContext, res: Response) {
  const callerAuthUserId = req.auth?.userId ?? req.internalUserId
  if (!callerAuthUserId) throw new HttpError(401, 'UNAUTHORIZED', 'Authenticated owner required')
  const merchant = await prisma.merchant.findFirst({ where: { ownerId: callerAuthUserId, deletedAt: null } })
  return res.json({ success: true, message: 'Success', data: merchant })
}

export async function getMerchantById(req: RequestWithContext, res: Response) {
  const merchantId = String(req.params.id)
  const merchant = await findMerchantById(merchantId)
  requireOwner(req, merchant.ownerId)
  return res.json({ success: true, message: 'Success', data: merchant })
}
export async function updateMerchant(req: RequestWithContext, res: Response) {
  const merchantId = String(req.params.id)
  const merchant = await findMerchantById(merchantId)
  requireOwner(req, merchant.ownerId)
  const updated = await updateProfile(merchant.id, req.body)
  return res.json({ success: true, message: 'Success', data: updated })
}
export async function updateMerchantStatus(req: RequestWithContext, res: Response) {
  requireAdmin(req)
  const merchantId = String(req.params.id)
  return res.json({ success: true, message: 'Success', data: await changeStatus(merchantId, req.body.status) })
}
export async function checkMerchantActive(req: RequestWithContext, res: Response) {
  // Minimal activity data is available to authenticated callers; bank details are never returned.
  const merchantId = String(req.params.id)
  const merchant = await findMerchantById(merchantId)
  return res.json({ success: true, message: 'Success', data: {
    id: merchant.id, ownerId: merchant.ownerId, businessName: merchant.businessName,
    status: merchant.status, active: merchant.status === 'APPROVED'
  } })
}
export async function createMerchantOutlet(req: RequestWithContext, res: Response) {
  const merchant = await findMerchantById(String(req.params.id))
  requireOwner(req, merchant.ownerId)
  const outlet = await createOutlet(merchant.id, req.body)
  return res.status(201).json({ success: true, message: 'Success', data: outlet })
}
export async function getMerchantOutlets(req: RequestWithContext, res: Response) {
  const merchant = await findMerchantById(String(req.params.id))
  requireOwner(req, merchant.ownerId)
  const { page, limit, search } = req.query as unknown as { page: number; limit: number; search: string }
  return res.json({ success: true, message: 'Success', data: await listOutlets(merchant.id, page, limit, search) })
}
export async function getMerchantOutletQr(req: RequestWithContext, res: Response) {
  const merchant = await findMerchantById(String(req.params.id))
  requireOwner(req, merchant.ownerId)
  const qr = await getOutletQr(merchant.id, String(req.params.outletId))
  // Signed payloads are per-request; never let an intermediary cache them.
  res.setHeader('Cache-Control', 'no-store')
  return res.json({ success: true, message: 'Success', data: qr })
}
export async function createMerchantApiKey(req: RequestWithContext, res: Response) {
  const merchant = await findMerchantById(String(req.params.id))
  requireOwner(req, merchant.ownerId)
  if (merchant.status !== 'APPROVED') throw new HttpError(409, 'MERCHANT_NOT_APPROVED', 'Merchant is not approved')
  const key = await issueApiKey(merchant.id)
  res.setHeader('Cache-Control', 'no-store')
  return res.status(201).json({ success: true, message: 'Success', data: key })
}
export async function revokeMerchantApiKey(req: RequestWithContext, res: Response) {
  const merchant = await findMerchantById(String(req.params.id))
  requireOwner(req, merchant.ownerId)
  const key = await revokeApiKey(merchant.id, String(req.params.keyId))
  return res.json({ success: true, message: 'Success', data: key })
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
  return res.json({ success: true, message: 'Success', data: { content, page, limit, totalElements, totalPages: Math.max(1, Math.ceil(totalElements / limit)) } })
}
