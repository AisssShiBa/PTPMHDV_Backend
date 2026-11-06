import { prisma } from '../config/prisma'
import { transaction } from '../utils/transaction'
import { HttpError } from '../utils/errors'
import { enqueue } from './merchant.service'
import { QR_VERSION, signOutletQr } from './qr.service'

export async function createOutlet(merchantId: string, data: { name: string; code: string }) {
  return transaction(async tx => {
    const merchant = await tx.merchant.findFirst({ where: { id: merchantId, deletedAt: null } })
    if (!merchant) throw new HttpError(404, 'NOT_FOUND', 'Merchant not found')
    // Only an approved merchant may expose a public point of sale.
    if (merchant.status !== 'APPROVED') throw new HttpError(409, 'MERCHANT_NOT_APPROVED', 'Merchant is not approved')
    const outlet = await tx.outlet.create({ data: { merchantId, ...data } })
    // Outlets are part of the merchant's public profile; reuse the registry-accepted event.
    const updated = await tx.merchant.update({ where: { id: merchantId }, data: { version: { increment: 1 } } })
    await enqueue(tx, updated, 'merchant.profile_updated')
    return outlet
  })
}

export async function listOutlets(merchantId: string, page: number, limit: number, search: string) {
  const where = {
    merchantId,
    ...(search ? { OR: [
      { name: { contains: search, mode: 'insensitive' as const } },
      { code: { contains: search, mode: 'insensitive' as const } }
    ] } : {})
  }
  const [content, totalElements] = await Promise.all([
    prisma.outlet.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' } }),
    prisma.outlet.count({ where })
  ])
  return { content, page, limit, totalElements, totalPages: Math.max(1, Math.ceil(totalElements / limit)) }
}

export async function getOutletQr(merchantId: string, outletId: string) {
  const merchant = await prisma.merchant.findFirst({ where: { id: merchantId, deletedAt: null } })
  if (!merchant) throw new HttpError(404, 'NOT_FOUND', 'Merchant not found')
  if (merchant.status !== 'APPROVED') throw new HttpError(409, 'MERCHANT_NOT_APPROVED', 'Merchant is not approved')
  // Filter on merchantId too, so an outletId belonging to another merchant never resolves.
  const outlet = await prisma.outlet.findFirst({ where: { id: outletId, merchantId } })
  if (!outlet) throw new HttpError(404, 'NOT_FOUND', 'Outlet not found')
  const issuedAt = Date.now()
  const { token, signature } = signOutletQr({
    version: QR_VERSION, merchantId: merchant.id, outletId: outlet.id, outletCode: outlet.code, issuedAt
  })
  return {
    version: QR_VERSION, merchantId: merchant.id, outletId: outlet.id, outletCode: outlet.code,
    issuedAt, token, signature, algorithm: 'HMAC-SHA256'
  }
}
