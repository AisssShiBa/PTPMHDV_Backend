export const DISCOUNT_PERCENT = 3n
export const VALID_AMOUNTS = ['10000', '20000', '50000', '100000', '200000', '500000'] as const
export const PHONE_PATTERN = /^(0|\+84)(3|5|7|8|9)\d{8}$/

export function normalisePhone(value: string): string {
  return value.startsWith('+84') ? `0${value.slice(3)}` : value
}

export function isAllowedAmount(value: string): boolean {
  return (VALID_AMOUNTS as readonly string[]).includes(value)
}

export function discountFor(amount: string): bigint {
  return (BigInt(amount) * DISCOUNT_PERCENT) / 100n
}

export function amountToIntegerString(value: { toFixed(fractionDigits: number): string }): string {
  const formatted = value.toFixed(0)
  if (!/^\d+$/.test(formatted)) throw new TypeError('Amount must be a non-negative integer')
  return formatted
}

// Converts a provider/payment amount ("50000" or "50000.00") to integer VND.
// Fractional VND has no meaning here, so any non-zero fraction is rejected.
export function amountFromDecimalString(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new TypeError('Amount must be a non-negative VND string')
  }
  const [whole, fraction = ''] = value.split('.')
  if (fraction.replace(/0/g, '').length > 0) {
    throw new TypeError('Amount must not contain a fractional VND part')
  }
  return whole
}
