import { Prisma, User as UserProfile } from '@prisma/client'
import { prisma } from '../config/prisma'
import { HttpError } from '../utils/errors'
import { transaction } from '../utils/transaction'
import { recordTierChange } from './kyc-tier.service'

export function findProfileByAuthUserId(authUserId: string): Promise<UserProfile> {
  return findProfile({ authUserId })
}

// Legacy /:id routes accept either ID. Keep ambiguity detection for compatibility.
export function resolveProfileByIdOrAuthUserId(profileIdOrAuthUserId: string): Promise<UserProfile> {
  return findProfile({ OR: [{ id: profileIdOrAuthUserId }, { authUserId: profileIdOrAuthUserId }] })
}

async function findProfile(where: Prisma.UserWhereInput): Promise<UserProfile> {
  const matches = await prisma.user.findMany({
    where,
    take: 2
  })
  // Include tombstones in ambiguity detection; never resolve an identifier to another account.
  if (matches.length > 1) throw new HttpError(409, 'AMBIGUOUS_IDENTIFIER', 'Use the explicit by-auth endpoint')
  const profile = matches[0]
  if (!profile || profile.deletedAt) throw new HttpError(404, 'NOT_FOUND', 'User not found')
  return profile
}

export function userResponse(profile: UserProfile) {
  const { kycObjectKey, kycBackObjectKey, idImageUrl, ...data } = profile
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
export async function setKycStatus(profile: UserProfile, status: UserProfile['kycStatus']) {
  if (profile.kycStatus === status) return profile
  const transitions: Record<UserProfile['kycStatus'], UserProfile['kycStatus'][]> = {
    NONE: [], PENDING: ['APPROVED', 'REJECTED'], APPROVED: ['REJECTED'], REJECTED: []
  }
  if (!transitions[profile.kycStatus].includes(status)) throw new HttpError(409, 'INVALID_TRANSITION', 'Invalid KYC status transition')
  if (status === 'APPROVED' && (!profile.kycObjectKey || !profile.kycBackObjectKey || !profile.idNumber))
    throw new HttpError(409, 'KYC_DOCUMENTS_REQUIRED', 'Both uploaded KYC images are required before approval')
  const profileId = profile.id
  return transaction(async tx => {
    const result = await tx.user.updateMany({
      where: { id: profileId, version: profile.version, deletedAt: null },
      data: { kycStatus: status, kycTier: status === 'APPROVED' ? 1 : status === 'REJECTED' ? 0 : profile.kycTier,
        version: { increment: 1 } }
    })
    if (result.count !== 1) throw new HttpError(409, 'CONCURRENT_UPDATE', 'Profile changed; reload and retry')
    const updated = await tx.user.findUniqueOrThrow({ where: { id: profileId } })
    await recordTierChange(tx, updated, profile.kycTier)
    return updated
  })
}
