import fs from 'node:fs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { DomainException } from './domain.exception';

const claims = z.object({ sub: z.string().uuid(), paymentId: z.string().uuid(),
  amount: z.string().regex(/^\d+$/), jti: z.string().uuid(), exp: z.number(), iat: z.number() });
export function transactionPublicKey() {
  const file = process.env.AUTH_TXN_PUBLIC_KEY_FILE;
  const value = file === undefined ? process.env.AUTH_TXN_PUBLIC_KEY : fs.readFileSync(file, 'utf8');
  if (!value?.trim()) throw new Error('AUTH_TXN_PUBLIC_KEY is required');
  const key = crypto.createPublicKey(value);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new Error('Auth transaction public key must use ES256 P-256');
  return value;
}
export function verifyPaymentToken(token: string) {
  const publicKey = transactionPublicKey();
  try {
    const result = claims.parse(jwt.verify(token, publicKey, {
      algorithms: ['ES256'], issuer: 'finvault-auth-service', audience: 'finvault-payment-service'
    }));
    if (result.exp - result.iat > 60 || result.iat > Math.floor(Date.now() / 1000)) throw new Error('Invalid token lifetime');
    return result;
  } catch (error: any) {
    if (error.name === 'TokenExpiredError') throw new DomainException(401, 'TXN_TOKEN_EXPIRED', 'Transaction token expired');
    throw new DomainException(403, 'TXN_TOKEN_MISMATCH', 'Invalid transaction authorization');
  }
}
