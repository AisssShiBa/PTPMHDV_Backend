import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Prisma, User } from '@prisma/client'
import { transaction } from '../utils/transaction'
import { HttpError } from '../utils/errors'

// Trusted domain operation only; profile/upload HTTP bodies cannot set this field.
export async function recordTierChange(tx: Prisma.TransactionClient, profile: User, previousTier: number) {
  if (profile.kycTier === previousTier) return
  const eventId = randomUUID()
  await tx.userOutboxEvent.create({ data: {
    id: eventId, aggregateId: profile.id, aggregateVersion: profile.version,
    eventType: 'user.kyc_updated',
    payload: {
      eventId, eventType: 'user.kyc_updated', eventVersion: 1, occurredAt: new Date().toISOString(),
      data: { authUserId: profile.authUserId, kycTier: profile.kycTier, previousTier }
    }
  } })
}

export async function updateKycTier(profileId: string, nextTier: number, requireApproved = false) {
  z.string().uuid().parse(profileId)
  z.number().int().min(0).max(2).parse(nextTier)
  return transaction(async tx => {
    const current = await tx.user.findFirst({ where: { id: profileId, deletedAt: null } })
    if (!current) throw new HttpError(404, 'NOT_FOUND', 'User not found')
    if (requireApproved && current.kycStatus !== 'APPROVED')
      throw new HttpError(409, 'KYC_NOT_APPROVED', 'Approve KYC before changing its tier')
    if (current.kycTier === nextTier) return current
    const profile = await tx.user.update({
      where: { id: profileId, deletedAt: null, version: current.version },
      data: { kycTier: nextTier, version: { increment: 1 } }
    })
    await recordTierChange(tx, profile, current.kycTier)
    return profile
  })
}
