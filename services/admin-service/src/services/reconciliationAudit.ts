import { prisma } from '../config/prisma'
import { createError } from '../middlewares/errorHandler'

// Generic audit helper for reconciliation actions. It mirrors the intent-first
// pattern in kycActions.ts: PENDING is persisted BEFORE the remote call, then
// the same row is updated to SUCCEEDED/REJECTED/UNKNOWN. When the PENDING row
// cannot be written the remote call must not happen at all.

export type ReconciliationAuditInput = {
  action: string
  adminId: string
  targetId: string
  detail: Record<string, unknown>
}

export type ReconciliationAuditOutcome = 'SUCCEEDED' | 'REJECTED' | 'UNKNOWN'

export function errorAuditDetail(error: unknown): Record<string, unknown> {
  const value = error as { status?: unknown; code?: unknown } | undefined
  return {
    ...(typeof value?.status === 'number' ? { status: value.status } : {}),
    ...(typeof value?.code === 'string' ? { failureCode: value.code } : {})
  }
}

export async function createPendingAudit(
  input: ReconciliationAuditInput
): Promise<{ id: string }> {
  try {
    return await prisma.adminAuditLog.create({
      data: {
        action: input.action,
        adminId: input.adminId,
        targetId: input.targetId,
        detail: JSON.stringify({ ...input.detail, outcome: 'PENDING' })
      }
    })
  } catch {
    throw createError(503, 'AUDIT_UNAVAILABLE', 'Cannot record the admin action; retry later')
  }
}

// A failed final audit write leaves the row at PENDING (an explicit unknown
// outcome) instead of turning a successful wallet mutation into an error.
export async function finishAudit(
  auditId: string,
  input: ReconciliationAuditInput,
  outcome: ReconciliationAuditOutcome,
  extra: Record<string, unknown> = {}
): Promise<void> {
  try {
    await prisma.adminAuditLog.update({
      where: { id: auditId },
      data: {
        detail: JSON.stringify({ ...input.detail, ...extra, outcome })
      }
    })
  } catch {
    console.error(JSON.stringify({ code: 'AUDIT_UPDATE_FAILED', action: input.action }))
  }
}

export async function auditedAction<T>(
  input: ReconciliationAuditInput,
  operation: () => Promise<T>,
  options: {
    outcomeFor(error: unknown): ReconciliationAuditOutcome
    successDetail?(data: T): Record<string, unknown>
  }
): Promise<T> {
  const audit = await createPendingAudit(input)
  try {
    const data = await operation()
    await finishAudit(audit.id, input, 'SUCCEEDED', options.successDetail?.(data) ?? {})
    return data
  } catch (error) {
    await finishAudit(audit.id, input, options.outcomeFor(error), errorAuditDetail(error))
    throw error
  }
}
