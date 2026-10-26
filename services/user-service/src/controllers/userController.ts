import { Response } from 'express'
import { prisma } from '../config/prisma'
import { RequestWithContext } from '../middlewares/requestId'
import { requireAdmin, requireOwner } from '../utils/access'
import { HttpError } from '../utils/errors'
import { findProfileByAuthUserId, resolveProfileByIdOrAuthUserId, setKycStatus, userResponse } from '../services/user.service'
import { kycBody, ListUsersQuery } from '../validations/user.validation'
import { submitDocuments, documentUrl, documentUrls } from '../services/kyc.service'
import { updateKycTier } from '../services/kyc-tier.service'
import { consumeLookupAttempt, lookupRecipient } from '../services/recipient-lookup'
import { z } from 'zod'

export async function lookupUser(req: RequestWithContext, res: Response) {
  if (!req.auth || req.auth.role !== 'USER') throw new HttpError(403, 'FORBIDDEN', 'User access required')
  res.setHeader('Cache-Control', 'no-store')
  try { await consumeLookupAttempt(req.auth.userId) }
  catch (error) {
    if (error instanceof HttpError && error.status === 429) res.setHeader('Retry-After', '60')
    throw error
  }
  const query = z.string().trim().min(1).max(254).parse(req.query.q)
  return res.json({ success: true, data: await lookupRecipient(query, req.auth.userId) })
}

export async function createUser(req: RequestWithContext, res: Response) {
  if (!req.isInternalCall) throw new HttpError(401, 'UNAUTHORIZED', 'Internal service credentials required')
  const profile = await prisma.user.create({ data: req.body })
  return res.status(201).json({ success: true, message: 'Success', data: userResponse(profile) })
}
export async function getUserById(req: RequestWithContext, res: Response) {
  const profile = await resolveProfileByIdOrAuthUserId(String(req.params.id))
  requireOwner(req, profile.authUserId)
  return res.json({ success: true, message: 'Success', data: userResponse(profile) })
}
export async function getUserByAuthUserId(req: RequestWithContext, res: Response) {
  const profile = await findProfileByAuthUserId(String(req.params.authUserId))
  requireOwner(req, profile.authUserId)
  return res.json({ success: true, message: 'Success', data: userResponse(profile) })
}
function findRequestedProfile(req: RequestWithContext) {
  return req.params.authUserId
    ? findProfileByAuthUserId(String(req.params.authUserId))
    : resolveProfileByIdOrAuthUserId(String(req.params.id))
}
export async function updateUser(req: RequestWithContext, res: Response) {
  const profile = await findRequestedProfile(req)
  requireOwner(req, profile.authUserId)
  const profileId = profile.id
  const updated = await prisma.user.update({ where: { id: profileId, deletedAt: null }, data: { ...req.body, version: { increment: 1 } } })
  return res.json({ success: true, message: 'Success', data: userResponse(updated) })
}
// Runs before multer buffers a file.
export async function authorizeKyc(req: RequestWithContext, res: Response, next: import('express').NextFunction) {
  const profile = await findRequestedProfile(req)
  requireOwner(req, profile.authUserId)
  res.locals.profile = profile
  next()
}
export async function submitKyc(req: RequestWithContext, res: Response) {
  const { idNumber } = kycBody.parse(req.body)
  const files = req.files as Record<string, Express.Multer.File[]> | undefined
  if (files?.front && files?.document) throw new HttpError(400, 'INVALID_UPLOAD', 'Use only one front image field')
  const front = files?.front?.[0] ?? files?.document?.[0]
  const back = files?.back?.[0]
  if (!front || !back) throw new HttpError(400, 'KYC_DOCUMENTS_REQUIRED', 'Upload both front and back images')
  const profile = await submitDocuments(res.locals.profile, idNumber, front, back)
  return res.status(202).json({ success: true, message: 'Success', data: userResponse(profile) })
}
export async function getKycDocument(req: RequestWithContext, res: Response) {
  if (req.auth?.role === 'ADMIN')
    throw new HttpError(403, 'FORBIDDEN', 'Use the audited Admin documents endpoint')
  res.setHeader('Cache-Control', 'no-store')
  return res.json({ success: true, message: 'Success', data: await documentUrl(res.locals.profile) })
}
export async function updateKycStatus(req: RequestWithContext, res: Response) {
  requireAdmin(req)
  const profile = await resolveProfileByIdOrAuthUserId(String(req.params.id))
  return res.json({ success: true, message: 'Success', data: userResponse(await setKycStatus(profile, req.body.kycStatus)) })
}
export async function changeKycTier(req: RequestWithContext, res: Response) {
  requireAdmin(req)
  const profile = await resolveProfileByIdOrAuthUserId(String(req.params.id))
  return res.json({ success: true, data: userResponse(await updateKycTier(profile.id, req.body.tier, true)) })
}
export async function getKycDocuments(req: RequestWithContext, res: Response) {
  // Admin must go through admin-service, which persists the viewing audit first.
  if (!req.isInternalCall) throw new HttpError(403, 'FORBIDDEN', 'Use the audited Admin documents endpoint')
  const profile = await resolveProfileByIdOrAuthUserId(String(req.params.id))
  res.setHeader('Cache-Control', 'no-store')
  return res.json({ success: true, data: await documentUrls(profile) })
}
export async function getUsers(req: RequestWithContext, res: Response) {
  requireAdmin(req)
  const { page, limit, search, kycStatus } = req.query as unknown as ListUsersQuery
  const where = { deletedAt: null, ...(kycStatus ? { kycStatus } : {}), ...(search ? { OR: [
    { email: { contains: search, mode: 'insensitive' as const } },
    { fullName: { contains: search, mode: 'insensitive' as const } }
  ] } : {}) }
  const [profiles, totalElements] = await Promise.all([
    prisma.user.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' } }),
    prisma.user.count({ where })
  ])
  return res.json({ success: true, message: 'Success', data: { content: profiles.map(userResponse), page, limit, totalElements, totalPages: Math.max(1, Math.ceil(totalElements / limit)) } })
}
async function currentProfile(req: RequestWithContext) {
  const callerAuthUserId = req.auth?.userId ?? req.internalUserId
  if (!callerAuthUserId) throw new HttpError(401, 'UNAUTHORIZED', 'Authenticated user required')
  return findProfileByAuthUserId(callerAuthUserId)
}
export async function getMe(req: RequestWithContext, res: Response) {
  return res.json({ success: true, message: 'Success', data: userResponse(await currentProfile(req)) })
}
export async function getMyKyc(req: RequestWithContext, res: Response) {
  const profile = await currentProfile(req)
  return res.json({ success: true, message: 'Success', data: {
    kycStatus: profile.kycStatus, kycTier: profile.kycTier, hasKycDocument: Boolean(profile.kycObjectKey)
  } })
}
export async function authorizeMyKyc(req: RequestWithContext, res: Response, next: import('express').NextFunction) {
  res.locals.profile = await currentProfile(req)
  next()
}
