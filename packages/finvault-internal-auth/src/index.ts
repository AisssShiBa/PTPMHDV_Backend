import fs from 'node:fs'
import { createPublicKey } from 'node:crypto'
import jwt, { SignOptions } from 'jsonwebtoken'
import type { Request, Response, NextFunction } from 'express'

export interface GatewayAuthContext {
  userId: string
  role: string
  kycTier: number
  jti: string
}
declare global {
  namespace Express { interface Request { auth?: GatewayAuthContext } }
}

// Public development fixture. Production must supply its own verification key.
export const DEV_STUB_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEniLUK7gZ7ZSYyWBnm3SiPUedQHwt
aeFpVr9DWDOaA02OcsSGq1K+pmzspers77x41nFYSqe/bQgOL9XONKkRwQ==
-----END PUBLIC KEY-----`

export function getGatewayPublicKey(): string {
  const path = process.env.GATEWAY_PUBLIC_KEY_FILE
  const configured = path ? fs.readFileSync(path, 'utf8').trim() : process.env.GATEWAY_PUBLIC_KEY?.trim()
  if (!configured && process.env.NODE_ENV === 'production') throw new Error('GATEWAY_PUBLIC_KEY is required in production')
  const pem = configured || DEV_STUB_PUBLIC_KEY
  const key = createPublicKey(pem)
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new Error('Gateway verification requires an ES256 public key')
  if (process.env.NODE_ENV === 'production' && key.export({ type: 'spki', format: 'pem' }).toString().trim() === DEV_STUB_PUBLIC_KEY)
    throw new Error('Development Gateway key is not permitted in production')
  return pem
}

export function verifyGatewayToken(token: string): GatewayAuthContext {
  const claims = jwt.verify(token, getGatewayPublicKey(), {
    algorithms: ['ES256'], issuer: 'finvault-gateway', audience: 'finvault-internal-services', maxAge: '60s'
  })
  const now = Math.floor(Date.now() / 1000)
  if (typeof claims === 'string' || typeof claims.sub !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.sub) ||
      !['USER', 'ADMIN', 'MERCHANT'].includes(claims.role) ||
      !Number.isInteger(claims.kycTier) || claims.kycTier < 0 || claims.kycTier > 2 ||
      typeof claims.jti !== 'string' || !claims.jti.trim() || claims.jti.length > 200 ||
      !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) ||
      claims.iat! > now || claims.exp! <= claims.iat! || claims.exp! - claims.iat! > 60)
    throw new Error('Invalid Gateway claims')
  return { userId: claims.sub, role: claims.role, kycTier: claims.kycTier, jti: claims.jti }
}

function fail(req: Request, res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ success: false, error: { code, message },
    requestId: (req as Request & { requestId?: string }).requestId || res.getHeader('x-request-id') })
}
export function requireGateway(req: Request, res: Response, next: NextFunction): void | Response {
  req.auth = undefined
  const token = req.headers['x-gateway-token']
  if (!token || typeof token !== 'string') return fail(req, res, 401, 'INVALID_GATEWAY_TOKEN', 'Gateway token required')
  try { req.auth = verifyGatewayToken(token) }
  catch { return fail(req, res, 401, 'INVALID_GATEWAY_TOKEN', 'Invalid or expired Gateway token') }
  return next()
}
export function requireRole(role: string) {
  return (req: Request, res: Response, next: NextFunction): void | Response => {
    if (!req.auth) return fail(req, res, 401, 'UNAUTHORIZED', 'Authentication required')
    if (req.auth.role !== role) return fail(req, res, 403, 'FORBIDDEN', 'Insufficient role')
    return next()
  }
}
// Preserve the documented helper API; never sign test tokens in production.
export function createTestGatewayToken(userId: string, role = 'USER', kycTier = 0,
  expiresIn: SignOptions['expiresIn'] = '60s'): string {
  if (process.env.NODE_ENV === 'production') throw new Error('Test tokens are disabled in production')
  return require('./testing').createTestGatewayToken(userId, role, kycTier, expiresIn)
}
