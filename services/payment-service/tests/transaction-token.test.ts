import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { verifyPaymentToken } from '../src/utils/transaction-token';

test('PIN authorization requires ES256 issuer/audience, valid claims and a 60-second lifetime', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  delete process.env.AUTH_TXN_PUBLIC_KEY_FILE;
  process.env.AUTH_TXN_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const payload = { sub: randomUUID(), paymentId: randomUUID(), amount: '1000', jti: randomUUID(),
    iss: 'finvault-auth-service', aud: 'finvault-payment-service' };
  const sign = (data: object, seconds = 60) => jwt.sign(data, privateKey, { algorithm: 'ES256', expiresIn: seconds });
  assert.equal(verifyPaymentToken(sign(payload)).jti, payload.jti);
  for (const invalid of [{ ...payload, aud: 'wallet' }, { ...payload, iss: 'gateway' },
    { ...payload, amount: '-1' }, { ...payload, jti: 'not-a-uuid' }]) {
    assert.throws(() => verifyPaymentToken(sign(invalid)), { code: 'TXN_TOKEN_MISMATCH' });
  }
  assert.throws(() => verifyPaymentToken(sign(payload, 120)), { code: 'TXN_TOKEN_MISMATCH' });
  assert.throws(() => verifyPaymentToken(sign(payload, -5)), { code: 'TXN_TOKEN_EXPIRED' });
  assert.throws(() => verifyPaymentToken(jwt.sign(payload, 'synthetic-hmac', { algorithm: 'HS256' })), { code: 'TXN_TOKEN_MISMATCH' });
});
