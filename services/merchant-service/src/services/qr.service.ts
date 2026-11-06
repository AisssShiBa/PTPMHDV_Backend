import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '../config/env'

export const QR_VERSION = 1

export interface OutletQrPayload {
  version: number
  merchantId: string
  outletId: string
  outletCode: string
  issuedAt: number
}

// Pipe-separated canonical form. Outlet codes are restricted to [A-Za-z0-9_-],
// so no field can contain the separator and each field boundary is unambiguous.
function canonical(payload: OutletQrPayload) {
  return [payload.version, payload.merchantId, payload.outletId, payload.outletCode, payload.issuedAt].join('|')
}

function sign(data: string) {
  return createHmac('sha256', env.merchantQrSecret).update(data, 'utf8').digest()
}

export function signOutletQr(payload: OutletQrPayload) {
  const body = canonical(payload)
  const signature = sign(body)
  return {
    token: Buffer.from(body, 'utf8').toString('base64url') + '.' + signature.toString('base64url'),
    signature: signature.toString('base64url')
  }
}

// Returns the payload only when the signature matches and the caller's expected
// merchant/outlet agree with what was signed (a QR from merchant B never passes for A).
export function verifyOutletQr(
  token: string,
  expected?: { merchantId?: string; outletId?: string }
): OutletQrPayload | null {
  const separator = token.lastIndexOf('.')
  if (separator <= 0) return null
  let body: string
  let presented: Buffer
  try {
    body = Buffer.from(token.slice(0, separator), 'base64url').toString('utf8')
    presented = Buffer.from(token.slice(separator + 1), 'base64url')
  } catch { return null }
  const actual = sign(body)
  if (presented.length !== actual.length || !timingSafeEqual(presented, actual)) return null
  const fields = body.split('|')
  if (fields.length !== 5) return null
  const [version, merchantId, outletId, outletCode, issuedAt] = fields
  if (Number(version) !== QR_VERSION || !Number.isInteger(Number(issuedAt))) return null
  if (expected?.merchantId !== undefined && expected.merchantId !== merchantId) return null
  if (expected?.outletId !== undefined && expected.outletId !== outletId) return null
  return { version: QR_VERSION, merchantId, outletId, outletCode, issuedAt: Number(issuedAt) }
}
