import { Response } from 'express'
import { prisma } from '../config/prisma'
import { RequestWithContext } from '../middlewares/requestId'
import { requireAdmin, requireOwner } from '../utils/access'
import { HttpError } from '../utils/errors'
import { resolveUser, setKycStatus, userResponse } from '../services/user.service'
import { kycBody, ListUsersQuery } from '../validations/user.validation'
import { submitDocument, documentUrl } from '../services/kyc.service'

export async function createUser(req: RequestWithContext, res: Response) {
  if (!req.isInternalCall) throw new HttpError(401, 'UNAUTHORIZED', 'Internal service credentials required')
  const user = await prisma.user.create({ data: req.body })
  return res.status(201).json({ success: true, data: userResponse(user) })
}
export async function getUserById(req: RequestWithContext, res: Response) {
  const user = await resolveUser(String(req.params.id))
  requireOwner(req, user.authUserId)
  return res.json({ success: true, data: userResponse(user) })
}
export async function getUserByAuthUserId(req: RequestWithContext, res: Response) {
  const user = await resolveUser(String(req.params.authUserId), true)
  requireOwner(req, user.authUserId)
  return res.json({ success: true, data: userResponse(user) })
}
export async function updateUser(req: RequestWithContext, res: Response) {
  const user = await resolveUser(String(req.params.authUserId || req.params.id), Boolean(req.params.authUserId))
  requireOwner(req, user.authUserId)
  const updated = await prisma.user.update({ where: { id: user.id, deletedAt: null }, data: { ...req.body, version: { increment: 1 } } })
  return res.json({ success: true, data: userResponse(updated) })
}
// Runs before multer buffers a file.
export async function authorizeKyc(req: RequestWithContext, res: Response, next: import('express').NextFunction) {
  const user = await resolveUser(String(req.params.authUserId || req.params.id), Boolean(req.params.authUserId))
  requireOwner(req, user.authUserId)
  res.locals.user = user
  next()
}
export async function submitKyc(req: RequestWithContext, res: Response) {
  const { idNumber } = kycBody.parse(req.body)
  if (!req.file) throw new HttpError(400, 'KYC_DOCUMENT_REQUIRED', 'Upload a JPEG or PNG using the document field')
  const user = await submitDocument(res.locals.user, idNumber, req.file)
  return res.json({ success: true, data: userResponse(user) })
}
export async function getKycDocument(_req: RequestWithContext, res: Response) {
  res.setHeader('Cache-Control', 'no-store')
  return res.json({ success: true, data: await documentUrl(res.locals.user) })
}
export async function updateKycStatus(req: RequestWithContext, res: Response) {
  requireAdmin(req)
  const user = await resolveUser(String(req.params.id))
  return res.json({ success: true, data: userResponse(await setKycStatus(user, req.body.kycStatus)) })
}
export async function getUsers(req: RequestWithContext, res: Response) {
  requireAdmin(req)
  const { page, limit, search, kycStatus } = req.query as unknown as ListUsersQuery
  const where = { deletedAt: null, ...(kycStatus ? { kycStatus } : {}), ...(search ? { OR: [
    { email: { contains: search, mode: 'insensitive' as const } },
    { fullName: { contains: search, mode: 'insensitive' as const } }
  ] } : {}) }
  const [users, totalElements] = await Promise.all([
    prisma.user.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' } }),
    prisma.user.count({ where })
  ])
  return res.json({ success: true, data: { content: users.map(userResponse), page, limit, totalElements, totalPages: Math.max(1, Math.ceil(totalElements / limit)) } })
}
