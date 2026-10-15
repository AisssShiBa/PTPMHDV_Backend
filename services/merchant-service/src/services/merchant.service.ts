import { Merchant, Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { prisma } from '../config/prisma'
import { transaction } from '../utils/transaction'
import { HttpError } from '../utils/errors'

export async function findMerchantById(merchantId: string) {
  const merchant = await prisma.merchant.findFirst({ where: { id: merchantId, deletedAt: null } })
  if (!merchant) throw new HttpError(404, 'NOT_FOUND', 'Merchant not found')
  return merchant
}
async function enqueue(tx: Prisma.TransactionClient, merchant: Merchant, eventType: string) {
  const eventId = randomUUID()
  await tx.merchantOutboxEvent.create({ data: {
    id: eventId, aggregateId: merchant.id, aggregateVersion: merchant.version, eventType,
    nextAttemptAt: new Date(0), // Immediately eligible, independent of application clock skew.
    payload: { eventId, eventType, eventVersion: 1, occurredAt: new Date().toISOString(),
      data: { merchantId: merchant.id, ownerId: merchant.ownerId, businessName: merchant.businessName,
        status: merchant.status, version: merchant.version } }
  } })
}
export async function register(data: { ownerId: string; businessName: string; taxId?: string | null; bankAccount?: string | null }) {
  // ownerId remains the owner's Auth ID in persistence and event payloads.
  return transaction(async tx => {
    const merchant = await tx.merchant.create({ data })
    await enqueue(tx, merchant, 'merchant.registered')
    return merchant
  })
}
export async function changeStatus(merchantId: string, status: Merchant['status']) {
  return transaction(async tx => {
    const current = await tx.merchant.findFirst({ where: { id: merchantId, deletedAt: null } })
    if (!current) throw new HttpError(404, 'NOT_FOUND', 'Merchant not found')
    if (current.status === status) return current // No-op: no version bump, no duplicate event.
    const transitions: Record<Merchant['status'], Merchant['status'][]> = {
      PENDING: ['APPROVED', 'REJECTED'], APPROVED: ['REJECTED'], REJECTED: ['PENDING']
    }
    if (!transitions[current.status].includes(status)) throw new HttpError(409, 'INVALID_TRANSITION', 'Invalid merchant status transition')
    const merchant = await tx.merchant.update({ where: { id: merchantId }, data: { status, version: { increment: 1 } } })
    await enqueue(tx, merchant, 'merchant.status_updated')
    return merchant
  })
}

export async function updateProfile(merchantId: string, data: {
  businessName?: string; taxId?: string | null; bankAccount?: string | null
}) {
  return transaction(async tx => {
    const current = await tx.merchant.findFirst({ where: { id: merchantId, deletedAt: null } })
    if (!current) throw new HttpError(404, 'NOT_FOUND', 'Merchant not found')
    // Whitelist editable fields even for callers other than the HTTP controller.
    const changes: typeof data = {}
    for (const field of ['businessName', 'taxId', 'bankAccount'] as const) {
      if (data[field] !== undefined && data[field] !== current[field]) {
        Object.assign(changes, { [field]: data[field] })
      }
    }
    if (Object.keys(changes).length === 0) return current
    const merchant = await tx.merchant.update({
      where: { id: merchantId, deletedAt: null }, data: { ...changes, version: { increment: 1 } }
    })
    await enqueue(tx, merchant, 'merchant.profile_updated')
    return merchant
  })
}
