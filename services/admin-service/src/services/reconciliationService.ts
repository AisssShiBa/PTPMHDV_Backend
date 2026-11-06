import { Prisma } from '@prisma/client'
import { prisma } from '../config/prisma'
import { createError } from '../middlewares/errorHandler'
import {
  getWalletReconciliationClient,
  WalletClientError,
  type WalletReconciliationReport,
  type WalletReportPage
} from './walletReconciliationClient'
import {
  auditedAction,
  createPendingAudit,
  errorAuditDetail,
  finishAudit,
  type ReconciliationAuditInput,
  type ReconciliationAuditOutcome
} from './reconciliationAudit'

export const RECONCILIATION_RUN_STALE_MS = 60_000

type AdminContext = {
  adminId: string
  requestId: string
  gatewayToken: string
}

const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'

const isDefiniteRejection = (error: unknown): boolean => {
  const status = (error as { status?: unknown } | undefined)?.status
  return typeof status === 'number' && status >= 400 && status < 500
}

// Never forward wallet internals. 401/403 become a generic 403, timeouts a
// 504, other 5xx/network failures a 502.
function mapWalletError(error: unknown): unknown {
  if (!(error instanceof WalletClientError)) return error
  if (error.status === 401 || error.status === 403) {
    return createError(403, 'FORBIDDEN', 'Wallet service denied the request')
  }
  if (error.timedOut) {
    return createError(504, 'WALLET_TIMEOUT', 'Wallet service did not respond in time')
  }
  if (typeof error.status === 'number' && error.status >= 400 && error.status < 500) {
    return createError(error.status, error.code ?? 'WALLET_REJECTED', error.message)
  }
  return createError(502, 'WALLET_UNAVAILABLE', 'Wallet service is unavailable')
}

function mapReportError(error: unknown): unknown {
  const mapped = mapWalletError(error) as { status?: number; code?: string; message?: string }
  if (mapped?.status === 404) {
    return createError(404, 'NOT_FOUND', 'Reconciliation report not found')
  }
  return mapped
}

function auditOutcomeFor(error: unknown): ReconciliationAuditOutcome {
  const mapped = mapWalletError(error) as { status?: number }
  return isDefiniteRejection(mapped) ? 'REJECTED' : 'UNKNOWN'
}

async function claimRun(
  mode: 'QUICK' | 'FULL',
  adminId: string,
  requestId: string
): Promise<{ id: string }> {
  // A crashed instance may leave a RUNNING row. Age it out first so the next
  // run is not blocked forever, then rely on the partial unique index for the
  // 60-second window (two concurrent requests cannot both insert).
  await prisma.reconciliationRunLog.updateMany({
    where: {
      mode,
      status: 'RUNNING',
      runAt: { lt: new Date(Date.now() - RECONCILIATION_RUN_STALE_MS) }
    },
    data: { status: 'UNKNOWN' }
  })
  try {
    return await prisma.reconciliationRunLog.create({
      data: { mode, adminId, requestId, status: 'RUNNING' }
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw createError(
        409,
        'RECONCILIATION_IN_PROGRESS',
        'A reconciliation run for this mode is already in progress'
      )
    }
    throw error
  }
}

export type RunReconciliationInput = AdminContext & { mode: 'quick' | 'full' }

export async function runReconciliation(
  input: RunReconciliationInput
): Promise<WalletReconciliationReport> {
  const mode = input.mode === 'full' ? 'FULL' : 'QUICK'
  const run = await claimRun(mode, input.adminId, input.requestId)
  const auditInput: ReconciliationAuditInput = {
    action: 'RUN_RECONCILIATION',
    adminId: input.adminId,
    targetId: 'reconciliation',
    // Never include the Gateway token here.
    detail: { mode: input.mode, requestId: input.requestId }
  }

  try {
    return await auditedAction(
      auditInput,
      async () => {
        const report = await getWalletReconciliationClient().run(input.mode === 'full', {
          gatewayToken: input.gatewayToken,
          requestId: input.requestId
        })
        await prisma.reconciliationRunLog.update({
          where: { id: run.id },
          data: {
            status: 'SUCCEEDED',
            walletReportId: String(report.id),
            isBalanced: report.isBalanced,
            anomaliesFound: report.anomaliesFound ?? report.anomalies.length
          }
        })
        return report
      },
      {
        outcomeFor: auditOutcomeFor,
        successDetail: report => ({
          walletReportId: String(report.id),
          isBalanced: report.isBalanced,
          anomaliesFound: report.anomaliesFound ?? report.anomalies.length
        })
      }
    )
  } catch (error) {
    const mapped = mapWalletError(error) as { status?: number }
    await prisma.reconciliationRunLog
      .update({
        where: { id: run.id },
        data: { status: isDefiniteRejection(mapped) ? 'FAILED' : 'UNKNOWN' }
      })
      .catch(() => {})
    throw mapped
  }
}

export type ListReportsInput = AdminContext & { page: number; limit: number }

export async function listReports(input: ListReportsInput): Promise<WalletReportPage> {
  try {
    return await getWalletReconciliationClient().listReports(input.page, input.limit, {
      gatewayToken: input.gatewayToken,
      requestId: input.requestId
    })
  } catch (error) {
    throw mapReportError(error)
  }
}

export type GetReportInput = AdminContext & { id: number }

export async function getReport(input: GetReportInput): Promise<WalletReconciliationReport> {
  try {
    return await getWalletReconciliationClient().getReport(input.id, {
      gatewayToken: input.gatewayToken,
      requestId: input.requestId
    })
  } catch (error) {
    throw mapReportError(error)
  }
}

type AdjustmentDirection = 'CREDIT' | 'DEBIT'

type ClaimOutcome =
  | { ok: true; created: boolean }
  | { ok: false; error: unknown }

async function claimAdjustment(input: {
  anomalyId: string
  adminId: string
  direction: AdjustmentDirection
  amount: string
  reason: string
}): Promise<{ created: boolean }> {
  const referenceId = `adjust-anomaly-${input.anomalyId}`
  let outcome: ClaimOutcome
  try {
    outcome = await prisma.$transaction(async transaction => {
      const existing = await transaction.anomalyAdjustment.findUnique({
        where: { anomalyId: input.anomalyId }
      })
      if (existing) {
        if (existing.status === 'SUCCEEDED') {
          return {
            ok: false,
            error: createError(409, 'ALREADY_ADJUSTED', 'This anomaly has already been adjusted')
          }
        }
        if (existing.status === 'PENDING') {
          return {
            ok: false,
            error: createError(
              409,
              'ADJUSTMENT_IN_PROGRESS',
              'An adjustment for this anomaly is in progress'
            )
          }
        }
        if (existing.status === 'UNKNOWN') {
          return {
            ok: false,
            error: createError(
              409,
              'ADJUSTMENT_OUTCOME_UNKNOWN',
              'The previous adjustment outcome is unknown; verify the ledger before retrying'
            )
          }
        }
        // A definite wallet rejection (FAILED) may be retried. The conditional
        // update makes exactly one concurrent request the winner.
        const claimed = await transaction.anomalyAdjustment.updateMany({
          where: { anomalyId: input.anomalyId, status: 'FAILED' },
          data: {
            adminId: input.adminId,
            direction: input.direction,
            amount: new Prisma.Decimal(input.amount),
            reason: input.reason,
            status: 'PENDING',
            failureReason: null,
            walletTransactionId: null
          }
        })
        if (claimed.count !== 1) {
          return {
            ok: false,
            error: createError(
              409,
              'ADJUSTMENT_IN_PROGRESS',
              'An adjustment for this anomaly is in progress'
            )
          }
        }
        return { ok: true, created: false }
      }

      await transaction.anomalyAdjustment.create({
        data: {
          anomalyId: input.anomalyId,
          adminId: input.adminId,
          direction: input.direction,
          amount: new Prisma.Decimal(input.amount),
          reason: input.reason,
          status: 'PENDING',
          // Fixed per anomaly so wallet's own idempotency deduplicates a
          // retry after FAILED.
          referenceId
        }
      })
      return { ok: true, created: true }
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw createError(409, 'ADJUSTMENT_IN_PROGRESS', 'An adjustment for this anomaly is in progress')
    }
    throw error
  }
  if (!outcome.ok) throw outcome.error
  return { created: outcome.created }
}

async function releaseClaim(anomalyId: string, created: boolean): Promise<void> {
  if (created) {
    await prisma.anomalyAdjustment.delete({ where: { anomalyId } }).catch(() => {})
    return
  }
  await prisma.anomalyAdjustment
    .updateMany({
      where: { anomalyId, status: 'PENDING' },
      data: { status: 'FAILED', failureReason: 'AUDIT_UNAVAILABLE' }
    })
    .catch(() => {})
}

export type AdjustAnomalyInput = AdminContext & {
  anomalyId: number
  direction: AdjustmentDirection
  amount: string
  reason: string
}

export type AdjustAnomalyResult = {
  anomalyId: string
  status: 'SUCCEEDED'
  referenceId: string
  transactionId: string | null
  replayed: boolean
}

export async function adjustAnomaly(input: AdjustAnomalyInput): Promise<AdjustAnomalyResult> {
  const anomalyId = String(input.anomalyId)
  const referenceId = `adjust-anomaly-${anomalyId}`
  const claim = await claimAdjustment({ ...input, anomalyId })

  const auditInput: ReconciliationAuditInput = {
    action: 'ADJUST_ANOMALY',
    adminId: input.adminId,
    targetId: anomalyId,
    detail: {
      direction: input.direction,
      amount: input.amount,
      reason: input.reason,
      referenceId,
      requestId: input.requestId
    }
  }

  let audit: { id: string }
  try {
    audit = await createPendingAudit(auditInput)
  } catch (error) {
    // Nothing was sent to the wallet; release the claim so the admin can retry.
    await releaseClaim(anomalyId, claim.created)
    throw error
  }

  try {
    const result = await getWalletReconciliationClient().adjustAnomaly(
      anomalyId,
      {
        direction: input.direction,
        amount: input.amount,
        reason: input.reason,
        referenceId
      },
      { gatewayToken: input.gatewayToken, requestId: input.requestId }
    )
    await prisma.anomalyAdjustment.update({
      where: { anomalyId },
      data: {
        status: 'SUCCEEDED',
        walletTransactionId: result.transactionId,
        failureReason: null
      }
    })
    await finishAudit(audit.id, auditInput, 'SUCCEEDED', {
      transactionId: result.transactionId,
      replayed: result.replayed
    })
    return {
      anomalyId,
      status: 'SUCCEEDED',
      referenceId,
      transactionId: result.transactionId,
      replayed: result.replayed
    }
  } catch (error) {
    if (error instanceof WalletClientError && isDefiniteRejection(error)) {
      const mapped = mapWalletError(error) as { status?: number; code?: string }
      await prisma.anomalyAdjustment.update({
        where: { anomalyId },
        data: { status: 'FAILED', failureReason: mapped.code ?? 'WALLET_REJECTED' }
      })
      await finishAudit(audit.id, auditInput, 'REJECTED', errorAuditDetail(mapped))
      throw mapped
    }

    // 5xx/timeout/network: money may have moved. Record UNKNOWN and do NOT
    // retry automatically; the fixed referenceId keeps a manual retry safe.
    await prisma.anomalyAdjustment.update({
      where: { anomalyId },
      data: { status: 'UNKNOWN' }
    })
    await finishAudit(audit.id, auditInput, 'UNKNOWN', errorAuditDetail(error))
    throw createError(
      503,
      'ADJUST_OUTCOME_UNKNOWN',
      'Wallet adjustment outcome is unknown; verify the ledger before retrying'
    )
  }
}
