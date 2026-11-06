import { UtilityOrder } from '@prisma/client'
import { prisma } from '../config/prisma'
import type { PaymentClient, ProviderClient, ProviderOutcome } from '../types/utility'
import { PaymentClientError } from './paymentClient'
import { transitionOrder } from './orderService'

export const MAX_REFUND_ATTEMPTS = 5

export async function executeRefund(
  order: Pick<UtilityOrder, 'id' | 'paymentId'>,
  paymentClient: PaymentClient
): Promise<void> {
  if (!order.paymentId) return
  try {
    const status = await paymentClient.requestRefund(order.paymentId)
    if (status === 'REFUNDED') {
      await transitionOrder(order.id, ['REFUND_REQUESTED'], 'REFUNDED', 'REFUND_CONFIRMED')
    }
    // REFUNDING and UNKNOWN stay REFUND_REQUESTED: never guess a money outcome.
  } catch (error) {
    if (error instanceof PaymentClientError && error.definite) {
      const code = error.upstreamCode ?? 'REFUND_REJECTED'
      await transitionOrder(
        order.id,
        ['REFUND_REQUESTED'],
        'REFUND_FAILED',
        `REFUND_REJECTED:${code}`,
        { failureReason: code }
      )
    }
    // 5xx/timeout: keep REFUND_REQUESTED for a bounded retry.
  }
}

export async function startRefund(
  orderId: string,
  reason: string,
  paymentClient: PaymentClient
): Promise<void> {
  const order = await prisma.$transaction(async tx => {
    const current = await tx.utilityOrder.findUnique({ where: { id: orderId } })
    if (!current) return null
    if (current.status !== 'PAID' && current.status !== 'PROVIDER_PENDING') return null
    const updated = await tx.utilityOrder.update({
      where: { id: current.id },
      data: {
        status: 'REFUND_REQUESTED',
        failureReason: reason,
        refundAttempts: { increment: 1 }
      }
    })
    await tx.utilityOrderHistory.create({
      data: {
        orderId: current.id,
        fromStatus: current.status,
        toStatus: 'REFUND_REQUESTED',
        note: reason
      }
    })
    return updated
  })
  if (order) await executeRefund(order, paymentClient)
}

export async function retryRefund(orderId: string, paymentClient: PaymentClient): Promise<void> {
  const order = await prisma.$transaction(async tx => {
    const current = await tx.utilityOrder.findUnique({ where: { id: orderId } })
    if (!current || current.status !== 'REFUND_REQUESTED') return null
    if (current.refundAttempts >= MAX_REFUND_ATTEMPTS) return null
    return tx.utilityOrder.update({
      where: { id: current.id },
      data: { refundAttempts: { increment: 1 } }
    })
  })
  if (order) await executeRefund(order, paymentClient)
}

export async function settleProviderOutcome(
  order: UtilityOrder,
  outcome: ProviderOutcome,
  paymentClient: PaymentClient
): Promise<void> {
  if (outcome.status === 'SUCCESS') {
    await transitionOrder(
      order.id,
      ['PROVIDER_PENDING'],
      'SUCCESS',
      'PROVIDER_SUCCEEDED',
      { providerRef: outcome.providerRef }
    )
    return
  }
  if (outcome.status === 'FAILED') {
    await startRefund(order.id, `PROVIDER_FAILED:${outcome.reason}`, paymentClient)
  }
  // TIMEOUT: keep PROVIDER_PENDING. Money may have moved, so refunding here
  // would be wrong (D10).
}

export async function fulfillPaidOrder(
  orderId: string,
  providerClient: ProviderClient,
  paymentClient: PaymentClient
): Promise<void> {
  const claimed = await transitionOrder(orderId, ['PAID'], 'PROVIDER_PENDING', 'PROVIDER_REQUESTED')
  if (!claimed) return

  const order = await prisma.utilityOrder.findUnique({ where: { id: orderId } })
  if (!order) return

  let outcome: ProviderOutcome
  try {
    outcome =
      order.type === 'TELCO_TOPUP'
        ? await providerClient.topup({
            orderId: order.id,
            phone: order.target,
            amount: order.amount.toFixed(0)
          })
        : await providerClient.payBill({
            orderId: order.id,
            providerCode: order.providerCode ?? 'UNKNOWN',
            customerCode: order.target,
            amount: order.amount.toFixed(0)
          })
  } catch {
    outcome = { status: 'TIMEOUT' }
  }
  await settleProviderOutcome(order, outcome, paymentClient)
}
