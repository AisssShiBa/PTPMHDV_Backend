import { createHash } from 'node:crypto'
import { Prisma, UtilityOrder, UtilityOrderStatus, UtilityType } from '@prisma/client'
import { prisma } from '../config/prisma'
import { HttpError, isUniqueConstraintError } from '../utils/errors'
import { discountFor } from '../utils/money'
import type { PaymentClient } from '../types/utility'
import { PaymentClientError } from './paymentClient'

const tails = new Map<string, Promise<void>>()

// Serialises creation/replay per (user, idempotency key) inside one process.
// Multi-instance safety still comes from the database unique constraint and
// payment-service's own idempotency key.
async function withKeyLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const tail = previous.then(() => gate)
  tails.set(key, tail)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (tails.get(key) === tail) tails.delete(key)
  }
}

export const payloadHashFor = (input: {
  type: UtilityType
  target: string
  amount: string
}): string =>
  createHash('sha256')
    .update(JSON.stringify({ type: input.type, target: input.target, amount: input.amount }))
    .digest('hex')

const history = (
  tx: Prisma.TransactionClient,
  orderId: string,
  fromStatus: UtilityOrderStatus | null,
  toStatus: UtilityOrderStatus,
  note: string
) => tx.utilityOrderHistory.create({ data: { orderId, fromStatus, toStatus, note } })

export async function transitionOrder(
  orderId: string,
  from: UtilityOrderStatus[],
  to: UtilityOrderStatus,
  note: string,
  extra: Prisma.UtilityOrderUpdateManyMutationInput = {}
): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const result = await tx.utilityOrder.updateMany({
      where: { id: orderId, status: { in: from } },
      data: { status: to, ...extra }
    })
    if (result.count === 0) return false
    await history(tx, orderId, from.length === 1 ? from[0] : null, to, note)
    return true
  })
}

export type CreateOrderInput = {
  userId: string
  idempotencyKey: string
  type: UtilityType
  amount: string
  target: string
  providerCode?: string | null
  gatewayToken: string
  requestId?: string
}

export type CreateOrderResult = {
  order: UtilityOrder
  replayed: boolean
}

const paymentTypeFor = (type: UtilityType): 'PHONE_TOPUP' | 'BILL_PAYMENT' =>
  type === 'TELCO_TOPUP' ? 'PHONE_TOPUP' : 'BILL_PAYMENT'

export async function createUtilityOrder(
  input: CreateOrderInput,
  paymentClient: PaymentClient
): Promise<CreateOrderResult> {
  const payloadHash = payloadHashFor(input)
  const lockKey = `${input.userId}:${input.idempotencyKey}`

  return withKeyLock(lockKey, async () => {
    const existing = await prisma.utilityOrder.findUnique({
      where: { userId_idempotencyKey: { userId: input.userId, idempotencyKey: input.idempotencyKey } }
    })

    let order: UtilityOrder
    let replayed: boolean

    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new HttpError(
          422,
          'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
          'Idempotency-Key đã được dùng cho một yêu cầu khác.'
        )
      }
      order = existing
      replayed = true
    } else {
      try {
        order = await prisma.$transaction(async tx => {
          const created = await tx.utilityOrder.create({
            data: {
              userId: input.userId,
              type: input.type,
              status: 'PENDING_PAYMENT',
              amount: new Prisma.Decimal(input.amount),
              discountAmount: new Prisma.Decimal(discountFor(input.amount).toString()),
              target: input.target,
              providerCode: input.providerCode ?? null,
              idempotencyKey: input.idempotencyKey,
              payloadHash
            }
          })
          await history(tx, created.id, null, 'PENDING_PAYMENT', 'ORDER_CREATED')
          return created
        })
        replayed = false
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error
        const raced = await prisma.utilityOrder.findUnique({
          where: {
            userId_idempotencyKey: { userId: input.userId, idempotencyKey: input.idempotencyKey }
          }
        })
        if (!raced || raced.payloadHash !== payloadHash) {
          throw new HttpError(
            422,
            'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
            'Idempotency-Key đã được dùng cho một yêu cầu khác.'
          )
        }
        order = raced
        replayed = true
      }
    }

    if (order.paymentId !== null || order.status !== 'PENDING_PAYMENT') {
      return { order, replayed }
    }

    // D8: no database transaction is held while calling payment-service.
    try {
      const payment = await paymentClient.checkout(
        {
          amount: input.amount,
          type: paymentTypeFor(input.type),
          referenceId: order.id,
          idempotencyKey: `util-${order.id}`
        },
        input.gatewayToken,
        input.requestId
      )
      const updated = await prisma.$transaction(async tx => {
        const changed = await tx.utilityOrder.findUnique({ where: { id: order.id } })
        if (!changed) throw new HttpError(404, 'NOT_FOUND', 'Không tìm thấy đơn.')
        const saved = await tx.utilityOrder.update({
          where: { id: order.id },
          data: { paymentId: payment.paymentId }
        })
        await history(tx, order.id, 'PENDING_PAYMENT', 'PENDING_PAYMENT', 'PAYMENT_CREATED')
        return saved
      })
      return { order: updated, replayed }
    } catch (error) {
      if (error instanceof PaymentClientError && error.definite) {
        const code = error.upstreamCode ?? 'PAYMENT_REJECTED'
        await transitionOrder(
          order.id,
          ['PENDING_PAYMENT'],
          'FAILED',
          `PAYMENT_REJECTED:${code}`,
          { failureReason: code }
        )
        throw new HttpError(error.status ?? 400, code, 'Thanh toán bị từ chối.')
      }
      // Unknown outcome: keep PENDING_PAYMENT. A retry with the same
      // idempotency key resumes this order instead of creating another.
      throw new HttpError(502, 'UPSTREAM_UNAVAILABLE', 'Không kết nối được payment-service.')
    }
  })
}

export async function findOrderForUser(orderId: string, userId: string): Promise<UtilityOrder> {
  const order = await prisma.utilityOrder.findFirst({ where: { id: orderId, userId } })
  if (!order) throw new HttpError(404, 'NOT_FOUND', 'Không tìm thấy đơn.')
  return order
}
