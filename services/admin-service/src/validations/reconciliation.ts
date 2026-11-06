import { createError } from '../middlewares/errorHandler'

// admin-service does not depend on zod; validation is deliberately manual so
// N13 does not introduce a new package.

export type RunMode = 'quick' | 'full'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export function parseRunMode(value: unknown): RunMode {
  if (value === undefined) return 'quick'
  if (value === 'quick' || value === 'full') return value
  throw createError(400, 'INVALID_MODE', "mode must be 'quick' or 'full'")
}

function positiveInt(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw createError(400, 'VALIDATION_ERROR', 'page and limit must be positive integers')
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw createError(400, 'VALIDATION_ERROR', 'page and limit must be positive integers')
  }
  return parsed
}

export function parsePagination(query: { page?: unknown; limit?: unknown }): {
  page: number
  limit: number
} {
  const page = positiveInt(query.page, 1)
  const limit = positiveInt(query.limit, 20)
  return {
    page: Math.max(1, page),
    // Hard cap protects wallet-service from an unbounded report scan.
    limit: Math.min(100, Math.max(1, limit))
  }
}

function positiveId(value: unknown, code: string, label: string): number {
  const text = Array.isArray(value) ? value[0] : value
  if (typeof text !== 'string' || !/^[1-9]\d*$/.test(text)) {
    throw createError(400, code, `${label} must be a positive integer`)
  }
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed)) {
    throw createError(400, code, `${label} must be a positive integer`)
  }
  return parsed
}

export function parseReportId(value: unknown): number {
  return positiveId(value, 'INVALID_REPORT_ID', 'report id')
}

export function parseAnomalyId(value: unknown): number {
  return positiveId(value, 'INVALID_ANOMALY_ID', 'anomaly id')
}

export type ParsedAdjustment = {
  direction: 'CREDIT' | 'DEBIT'
  amount: string
  reason: string
}

export function parseAdjustment(body: unknown): ParsedAdjustment {
  const input = isRecord(body) ? body : {}

  const direction = input.direction
  if (direction !== 'CREDIT' && direction !== 'DEBIT') {
    throw createError(400, 'INVALID_DIRECTION', "direction must be 'CREDIT' or 'DEBIT'")
  }

  const amount = input.amount
  if (typeof amount !== 'string' || !/^[1-9]\d*$/.test(amount)) {
    throw createError(400, 'INVALID_AMOUNT', 'amount must be a positive integer string')
  }
  // DECIMAL(20,2) leaves 18 integer digits; bigger values are rejected before
  // the database would overflow.
  if (amount.length > 18 || BigInt(amount) > 999_999_999_999_999_999n) {
    throw createError(400, 'INVALID_AMOUNT', 'amount is out of range')
  }

  const rawReason = input.reason
  if (typeof rawReason !== 'string' || rawReason.trim().length === 0) {
    throw createError(400, 'REASON_REQUIRED', 'reason is required')
  }
  const reason = rawReason.trim()
  if (reason.length < 5) {
    throw createError(400, 'REASON_REQUIRED', 'reason must contain 5 to 500 characters')
  }
  if (reason.length > 500) {
    throw createError(400, 'INVALID_REASON', 'reason must contain 5 to 500 characters')
  }

  return { direction, amount, reason }
}
