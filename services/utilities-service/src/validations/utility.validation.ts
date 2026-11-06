import { z } from 'zod'
import { HttpError } from '../utils/errors'
import { isAllowedAmount, normalisePhone, PHONE_PATTERN } from '../utils/money'

const bodySchema = z.object({
  phone: z.string().optional(),
  amount: z.string().optional(),
  provider: z.string().optional(),
  customerCode: z.string().optional()
})

export const requireIdempotencyKey = (value: string | undefined): string => {
  if (value === undefined || value.trim().length === 0) {
    throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Header Idempotency-Key là bắt buộc.')
  }
  if (value.length > 255) {
    throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key tối đa 255 ký tự.')
  }
  return value
}

const parseBody = (body: unknown) => {
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Dữ liệu gửi lên không hợp lệ.')
  }
  return parsed.data
}

export function parseTopupBody(body: unknown): { phone: string; amount: string } {
  const parsed = parseBody(body)
  if (typeof parsed.phone !== 'string' || !PHONE_PATTERN.test(parsed.phone)) {
    throw new HttpError(400, 'INVALID_PHONE', 'Số điện thoại không hợp lệ.')
  }
  if (typeof parsed.amount !== 'string' || !isAllowedAmount(parsed.amount)) {
    throw new HttpError(400, 'INVALID_AMOUNT', 'Mệnh giá nạp tiền không hợp lệ.')
  }
  return { phone: normalisePhone(parsed.phone), amount: parsed.amount }
}

export function parseBillPayBody(body: unknown): {
  provider: string
  customerCode: string
  amount: string
} {
  const parsed = parseBody(body)
  if (typeof parsed.provider !== 'string' || !/^[A-Za-z0-9._-]{2,32}$/.test(parsed.provider)) {
    throw new HttpError(400, 'INVALID_PROVIDER', 'Mã nhà cung cấp không hợp lệ.')
  }
  if (
    typeof parsed.customerCode !== 'string' ||
    !/^[A-Za-z0-9._-]{2,64}$/.test(parsed.customerCode)
  ) {
    throw new HttpError(400, 'INVALID_CUSTOMER_CODE', 'Mã khách hàng không hợp lệ.')
  }
  if (
    typeof parsed.amount !== 'string' ||
    !/^\d+$/.test(parsed.amount) ||
    BigInt(parsed.amount) <= 0n
  ) {
    throw new HttpError(400, 'INVALID_AMOUNT', 'Số tiền hóa đơn không hợp lệ.')
  }
  return {
    provider: parsed.provider,
    customerCode: parsed.customerCode,
    amount: parsed.amount
  }
}

export function parseMockTopupBody(body: unknown): {
  orderId: string
  phone: string
  amount: string
} {
  const parsed = bodySchema.safeParse(body)
  const record = (body ?? {}) as Record<string, unknown>
  const orderId = record.orderId
  if (
    !parsed.success ||
    typeof orderId !== 'string' ||
    orderId.length === 0 ||
    orderId.length > 100 ||
    typeof record.phone !== 'string' ||
    record.phone.length === 0 ||
    typeof record.amount !== 'string'
  ) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Mock provider payload không hợp lệ.')
  }
  return { orderId, phone: record.phone, amount: record.amount }
}
