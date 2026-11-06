import { HttpError } from '../utils/errors'

export type BillLookup = {
  provider: string
  customerCode: string
  customerName: string
  amount: string
  period: string
}

const formatVnd = (value: bigint): string =>
  value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')

// Sandbox bill lookup. The amount is derived from the last two digits of the
// customer code, which keeps tests and demos reproducible without randomness.
export function lookupBill(provider: string, customerCode: string): BillLookup {
  if (!/^[A-Za-z0-9._-]{2,64}$/.test(customerCode)) {
    throw new HttpError(400, 'INVALID_CUSTOMER_CODE', 'Mã khách hàng không hợp lệ.')
  }
  if (!/^[A-Za-z0-9._-]{2,32}$/.test(provider)) {
    throw new HttpError(400, 'INVALID_PROVIDER', 'Mã nhà cung cấp không hợp lệ.')
  }

  const tail = customerCode.slice(-2)
  if (!/^\d{2}$/.test(tail)) {
    throw new HttpError(400, 'INVALID_CUSTOMER_CODE', 'Mã khách hàng phải kết thúc bằng 2 chữ số.')
  }
  if (tail === '11') {
    throw new HttpError(422, 'BILL_NOT_FOUND', 'Nhà cung cấp không tìm thấy hóa đơn.')
  }
  if (tail === '22') {
    throw new HttpError(504, 'PROVIDER_TIMEOUT', 'Nhà cung cấp không phản hồi.')
  }

  const amount = BigInt(Number(tail) * 1000 + 10000)
  return {
    provider,
    customerCode,
    customerName: `Khách hàng ${customerCode.slice(-4)}`,
    amount: amount.toString(),
    period: '2026-10'
  }
}

export const formatBillAmount = (value: string | bigint): string => formatVnd(BigInt(value))
