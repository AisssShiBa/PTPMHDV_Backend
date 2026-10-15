import { randomUUID } from 'node:crypto'
import jwt, { SignOptions } from 'jsonwebtoken'

// Publicly known fixture, never a deployment credential.
export const DEV_STUB_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtGfFMFMTiOTdDVxb
ByJfXc0gszqTpA2mwaMOqlbElNmhRANCAASeItQruBntlJjJYGebdKI9R51AfC1p
4WlWv0NYM5oDTY5yxIarUr6mbOyl6uzvvHjWcVhKp79tCA4v1c40qRHB
-----END PRIVATE KEY-----`
export function createTestGatewayToken(userId: string, role = 'USER', kycTier = 0,
  expiresIn: SignOptions['expiresIn'] = '60s'): string {
  if (process.env.NODE_ENV === 'production') throw new Error('Test tokens are disabled in production')
  return jwt.sign({ sub: userId, role, kycTier, jti: randomUUID() }, DEV_STUB_PRIVATE_KEY, {
    algorithm: 'ES256', issuer: 'finvault-gateway', audience: 'finvault-internal-services', expiresIn
  })
}
