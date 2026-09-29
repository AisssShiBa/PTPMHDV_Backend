import { Prisma, User } from '@prisma/client'
import { prisma } from '../config/prisma'
import { HttpError } from '../utils/errors'
import { transaction } from '../utils/transaction'

export async function resolveUser(identifier: string, byAuth = false): Promise<User> {
  const matches = await prisma.user.findMany({
    where: byAuth ? { authUserId: identifier } : { OR: [{ id: identifier }, { authUserId: identifier }] },
    take: 2
  })
  // Include tombstones in ambiguity detection; never resolve an identifier to another account.
  if (matches.length > 1) throw new HttpError(409, 'AMBIGUOUS_IDENTIFIER', 'Use the explicit by-auth endpoint')
  const user = matches[0]
  if (!user || user.deletedAt) throw new HttpError(404, 'NOT_FOUND', 'User not found')
  return user
}

export function userResponse(user: User) {
  const { kycObjectKey, idImageUrl, ...data } = user
  return { ...data, hasKycDocument: Boolean(kycObjectKey) }
}
export async function provisionProfile(tx: Prisma.TransactionClient, authUserId: string, email: string) {
  const existing = await tx.user.findUnique({ where: { authUserId } })
  if (existing) {
    if (existing.deletedAt || existing.email !== email) throw new HttpError(409, 'PROFILE_CONFLICT', 'Profile conflicts with registration')
    return existing
  }
  const duplicate = await tx.user.findUnique({ where: { email } })
  if (duplicate) throw new HttpError(409, 'PROFILE_CONFLICT', 'Email belongs to another profile')
  return tx.user.create({ data: { authUserId, email } })
}
export async function setKycStatus(user: User, status: User['kycStatus']) {
  if (user.kycStatus === status) return user
  const transitions: Record<User['kycStatus'], User['kycStatus'][]> = {
    NONE: [], PENDING: ['APPROVED', 'REJECTED'], APPROVED: ['REJECTED'], REJECTED: []
  }
  if (!transitions[user.kycStatus].includes(status)) throw new HttpError(409, 'INVALID_TRANSITION', 'Invalid KYC status transition')
  if (status === 'APPROVED' && (!user.kycObjectKey || !user.idNumber))
    throw new HttpError(409, 'KYC_DOCUMENT_REQUIRED', 'A verified upload is required before approval')
  return transaction(async tx => {
    const result = await tx.user.updateMany({
      where: { id: user.id, version: user.version, deletedAt: null },
      data: { kycStatus: status, version: { increment: 1 } }
    })
    if (result.count !== 1) throw new HttpError(409, 'CONCURRENT_UPDATE', 'Profile changed; reload and retry')
    return tx.user.findUniqueOrThrow({ where: { id: user.id } })
  })
}
