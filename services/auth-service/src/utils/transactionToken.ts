import crypto from 'node:crypto'
import fs from 'node:fs'
import jwt from 'jsonwebtoken'
import { AppError } from './errors'

export interface TransactionTokenPayload {
  iss: string
  aud: string
  sub: string
  paymentId: string
  amount: string
  jti: string
  iat?: number
  exp?: number
}

function key(name: string): string {
  const file = process.env[name + '_FILE']
  let value: string | undefined
  if (file !== undefined) {
    try { value = fs.readFileSync(file, 'utf8').trim() }
    catch { throw new Error('Cannot read required key: ' + name + '_FILE') }
  } else value = process.env[name]?.trim()
  if (!value) throw new Error('Missing or empty required key: ' + name)
  return value
}
export const getAuthTxnPrivateKey = () => key('AUTH_TXN_PRIVATE_KEY')
export const getAuthTxnPublicKey = () => key('AUTH_TXN_PUBLIC_KEY')

export function validateTransactionKeys(): void {
  const privateKey = crypto.createPrivateKey(getAuthTxnPrivateKey())
  const publicKey = crypto.createPublicKey(getAuthTxnPublicKey())
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new Error('Auth-Txn signing requires an ES256 P-256 key')
  const derived = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })
  if (derived !== publicKey.export({ type: 'spki', format: 'pem' }))
    throw new Error('Auth-Txn public/private keys do not match')
  // Public fingerprint of the retired development key; its private key was public.
  if (publicKey.export({ type: 'spki', format: 'der' }).toString('base64') ===
      'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEc0Zn3u+YxvL3UVOxNFYovMRcuD4uDTQNSXJm0cUp0o4NQEj/At3JoZMk3avIRwC02kFj1SdeXKwy202ltsZcAg==')
    throw new Error('Retired development Auth-Txn key is not permitted')
}
export function signTransactionToken(userId: string, paymentId: string, amount: string): string {
  if (!userId || !paymentId || !amount)
    throw new AppError(400, 'INVALID_INPUT', 'userId, paymentId and amount are required')
  return jwt.sign({
    iss: 'finvault-auth-service', aud: 'finvault-payment-service',
    sub: userId, paymentId, amount, jti: crypto.randomUUID()
  }, getAuthTxnPrivateKey(), { algorithm: 'ES256', expiresIn: '60s' })
}
export function verifyTransactionToken(token: string): TransactionTokenPayload {
  try {
    return jwt.verify(token, getAuthTxnPublicKey(), {
      algorithms: ['ES256'], issuer: 'finvault-auth-service', audience: 'finvault-payment-service'
    }) as TransactionTokenPayload
  } catch (error: any) {
    if (error.name === 'TokenExpiredError')
      throw new AppError(401, 'TRANSACTION_TOKEN_EXPIRED', 'Transaction token expired')
    if (error.name === 'JsonWebTokenError')
      throw new AppError(403, 'INVALID_TRANSACTION_TOKEN', 'Invalid transaction token')
    throw error
  }
}
