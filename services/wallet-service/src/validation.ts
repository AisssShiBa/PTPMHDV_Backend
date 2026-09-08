import { Prisma } from '@prisma/client'
import { HttpError } from './errors'

export function parsePositiveId(value: unknown, field = 'userId'): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new HttpError(400, `${field} must be a positive integer`, 'INVALID_INPUT')
  }

  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new HttpError(400, `${field} must be a positive integer`, 'INVALID_INPUT')
  }

  return id
}

export function parseAmount(value: unknown): Prisma.Decimal {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    (typeof value === 'string' && value.trim() === '') ||
    (typeof value === 'number' && !Number.isFinite(value))
  ) {
    throw new HttpError(400, 'amount must be a positive decimal', 'INVALID_AMOUNT')
  }

  let amount: Prisma.Decimal
  try {
    amount = new Prisma.Decimal(value)
  } catch {
    throw new HttpError(400, 'amount must be a positive decimal', 'INVALID_AMOUNT')
  }

  if (!amount.isFinite() || amount.lte(0) || amount.decimalPlaces() > 2) {
    throw new HttpError(
      400,
      'amount must be positive and have at most 2 decimal places',
      'INVALID_AMOUNT'
    )
  }

  return amount
}

export function parseRefId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 255) {
    throw new HttpError(400, 'refId must be a non-empty string', 'INVALID_INPUT')
  }

  return value.trim()
}

export function parseIdempotencyKey(value: string | undefined): string {
  if (!value || value.trim() === '' || value.length > 255) {
    throw new HttpError(
      400,
      'Idempotency-Key header is required',
      'IDEMPOTENCY_KEY_REQUIRED'
    )
  }

  return value.trim()
}

export function parsePagination(pageValue: string | undefined, limitValue: string | undefined) {
  const page = pageValue === undefined ? 1 : Number(pageValue)
  const limit = limitValue === undefined ? 20 : Number(limitValue)

  if (
    !Number.isInteger(page) ||
    page < 1 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new HttpError(
      400,
      'page must be >= 1 and limit must be between 1 and 100',
      'INVALID_PAGINATION'
    )
  }

  return { page, limit, skip: (page - 1) * limit }
}

export function decimalToNumber(value: Prisma.Decimal): number {
  return Number(value.toFixed(2))
}
