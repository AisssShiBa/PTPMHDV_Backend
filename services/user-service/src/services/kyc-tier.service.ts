import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { transaction } from '../utils/transaction'
import { HttpError } from '../utils/errors'

// Trusted domain operation only; profile/upload HTTP bodies cannot set this field.
// Tier remains independent of KYC approval until a separate policy is agreed.
export async function updateKycTier(profileId: string, nextTier: number) {
  z.string().uuid().parse(profileId)
  z.number().int().min(0).max(2).parse(nextTier)
  return transaction(async tx => {
    const current = await tx.user.findFirst({ where: { id: profileId, deletedAt: null } })
    if (!current) throw new HttpError(404, 'NOT_FOUND', 'User not found')
    if (current.kycTier === nextTier) return current
    const user = await tx.user.update({
      where: { id: profileId, deletedAt: null, version: current.version },
      data: { kycTier: nextTier, version: { increment: 1 } }
    })
    const eventId = randomUUID()
    await tx.userOutboxEvent.create({ data: {
      id: eventId, aggregateId: user.id, aggregateVersion: user.version,
      eventType: 'user.kyc_updated',
      payload: {
        eventId, eventType: 'user.kyc_updated', eventVersion: 1, occurredAt: new Date().toISOString(),
        data: { authUserId: user.authUserId, kycTier: user.kycTier }
      }
    } })
    return user
  })
}
