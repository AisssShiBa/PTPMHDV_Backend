import { prisma } from '../config/prisma'
import type { PaymentClient, ProviderClient } from '../types/utility'
import {
  fulfillPaidOrder,
  retryRefund,
  settleProviderOutcome
} from './fulfillmentService'
import { transitionOrder } from './orderService'

export const CHECKOUT_STALE_MS = 120_000
export const RECOVERY_BATCH_SIZE = 20

export type RecoveryDependencies = {
  paymentClient: PaymentClient
  providerClient: ProviderClient
}

export type RecoverySummary = {
  paidRetried: number
  providerChecked: number
  abandonedCheckouts: number
  refundsRetried: number
}

// Safe to run on several instances: every state change is a conditional
// updateMany, so only one worker wins each claim.
export async function runRecoveryOnce(
  dependencies: RecoveryDependencies,
  now: Date,
  staleMs: number
): Promise<RecoverySummary> {
  const stale = new Date(now.getTime() - staleMs)
  const summary: RecoverySummary = {
    paidRetried: 0,
    providerChecked: 0,
    abandonedCheckouts: 0,
    refundsRetried: 0
  }

  const paid = await prisma.utilityOrder.findMany({
    where: { status: 'PAID', updatedAt: { lt: stale } },
    orderBy: { updatedAt: 'asc' },
    take: RECOVERY_BATCH_SIZE
  })
  for (const order of paid) {
    const before = await prisma.utilityOrder.findUnique({ where: { id: order.id } })
    if (before?.status !== 'PAID') continue
    await fulfillPaidOrder(order.id, dependencies.providerClient, dependencies.paymentClient)
    summary.paidRetried += 1
  }

  const providerPending = await prisma.utilityOrder.findMany({
    where: { status: 'PROVIDER_PENDING', updatedAt: { lt: stale } },
    orderBy: { updatedAt: 'asc' },
    take: RECOVERY_BATCH_SIZE
  })
  for (const order of providerPending) {
    const current = await prisma.utilityOrder.findUnique({ where: { id: order.id } })
    if (current?.status !== 'PROVIDER_PENDING') continue
    const outcome = await dependencies.providerClient.getStatus(order.id)
    await settleProviderOutcome(current, outcome, dependencies.paymentClient)
    summary.providerChecked += 1
  }

  const abandonedBefore = new Date(now.getTime() - CHECKOUT_STALE_MS)
  const abandoned = await prisma.utilityOrder.findMany({
    where: {
      status: 'PENDING_PAYMENT',
      paymentId: null,
      createdAt: { lt: abandonedBefore }
    },
    select: { id: true },
    take: RECOVERY_BATCH_SIZE
  })
  for (const { id } of abandoned) {
    const changed = await transitionOrder(
      id,
      ['PENDING_PAYMENT'],
      'FAILED',
      'CHECKOUT_NOT_CREATED',
      { failureReason: 'CHECKOUT_NOT_CREATED' }
    )
    if (changed) summary.abandonedCheckouts += 1
  }

  const refunds = await prisma.utilityOrder.findMany({
    where: { status: 'REFUND_REQUESTED', refundAttempts: { lt: 5 }, updatedAt: { lt: stale } },
    select: { id: true },
    take: RECOVERY_BATCH_SIZE
  })
  for (const { id } of refunds) {
    await retryRefund(id, dependencies.paymentClient)
    summary.refundsRetried += 1
  }

  return summary
}

export type RecoveryJob = { stop(): void }

export function createRecoveryJob(
  dependencies: RecoveryDependencies,
  options: { enabled: boolean; intervalMs: number; staleMs: number; log?: (message: string) => void }
): RecoveryJob | undefined {
  if (!options.enabled) return undefined
  let running = true
  let timer: NodeJS.Timeout | undefined

  const tick = async () => {
    if (!running) return
    try {
      const summary = await runRecoveryOnce(dependencies, new Date(), options.staleMs)
      const touched =
        summary.paidRetried + summary.providerChecked + summary.abandonedCheckouts + summary.refundsRetried
      if (touched > 0) {
        ;(options.log ?? console.log)(
          `[Utilities recovery] ${JSON.stringify(summary)}`
        )
      }
    } catch (error) {
      console.error('[Utilities recovery] sweep failed', error)
    } finally {
      if (running) timer = setTimeout(tick, options.intervalMs)
    }
  }

  timer = setTimeout(tick, options.intervalMs)
  timer.unref?.()

  return {
    stop() {
      running = false
      if (timer) clearTimeout(timer)
    }
  }
}
