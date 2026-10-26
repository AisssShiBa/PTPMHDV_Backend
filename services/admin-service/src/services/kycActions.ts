import { env } from '../config/env'
import { prisma } from '../config/prisma'
import { createError } from '../middlewares/errorHandler'

async function userRequest(path: string, requestId: string, body?: unknown) {
  const response = await fetch(`${env.userServiceUrl}/api/users/${path}`, {
    method: body === undefined ? 'GET' : 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-internal-key': env.internalKey, 'x-request-id': requestId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000)
  })
  const json = await response.json()
  if (!response.ok) {
    const status = [400, 403, 404, 409, 422].includes(response.status) ? response.status : 502
    throw createError(status, json.error?.code || 'KYC_UPSTREAM_ERROR',
      status === 502 ? 'User service is unavailable' : json.error?.message || 'KYC request rejected')
  }
  return json.data
}

// The databases are separate: persist intent BEFORE changing user-service.
// A lost response/final audit write leaves an explicit UNKNOWN/PENDING record,
// so no successful remote mutation can be entirely absent from the audit trail.
async function audited(action: string, userId: string, adminId: string, requestId: string,
  reason: string | undefined, operation: () => Promise<any>) {
  let audit
  const detail = { requestId, reason }
  try {
    audit = await prisma.adminAuditLog.create({ data: {
      action, adminId, targetId: userId, detail: JSON.stringify({ ...detail, outcome: 'PENDING' })
    } })
  } catch { throw createError(503, 'AUDIT_UNAVAILABLE', 'Cannot record the admin action; retry later') }
  try {
    const data = await operation()
    const auditLog = await prisma.adminAuditLog.update({ where: { id: audit.id }, data: {
      detail: JSON.stringify({ ...detail, outcome: 'SUCCEEDED', kycTier: data.kycTier, kycStatus: data.kycStatus })
    } })
    return { success: true, data, auditLog }
  } catch (error) {
    const status = (error as { status?: number }).status
    await prisma.adminAuditLog.update({ where: { id: audit.id }, data: {
      detail: JSON.stringify({ ...detail, outcome: status && status < 500 ? 'REJECTED' : 'UNKNOWN' })
    } }).catch(() => {})
    if (status) throw error
    throw createError(503, 'KYC_OUTCOME_UNKNOWN', 'Request outcome is uncertain; check the profile and audit before retrying')
  }
}

export const KycActions = {
  review(userId: string, status: 'APPROVED' | 'REJECTED', reason: string | undefined, adminId: string, requestId: string) {
    return audited(status === 'APPROVED' ? 'APPROVE_KYC' : 'REJECT_KYC', userId, adminId, requestId, reason,
      () => userRequest(`${userId}/kyc-status`, requestId, { kycStatus: status }))
  },
  changeTier(userId: string, tier: 1 | 2, reason: string, adminId: string, requestId: string) {
    return audited('UPDATE_KYC_TIER', userId, adminId, requestId, reason,
      () => userRequest(`${userId}/kyc-tier`, requestId, { tier, reason }))
  },
  documents(userId: string, adminId: string, requestId: string) {
    return audited('VIEW_KYC_DOCUMENTS', userId, adminId, requestId, undefined,
      () => userRequest(`${userId}/kyc/documents`, requestId))
  }
}
