import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { requireTransactionToken } from '../src/middlewares/transactionToken';
import { checkoutSchema, p2pCheckoutSchema } from '../src/validations/payment.validation';

test('accepts both PIN token transports and rejects mismatches, replay-invalid claims and expiry', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  process.env.AUTH_TXN_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  delete process.env.AUTH_TXN_PUBLIC_KEY_FILE;
  const payload = { sub: randomUUID(), paymentId: randomUUID(), amount: '1000', jti: randomUUID() };
  const sign = (seconds: number) => jwt.sign(payload, privateKey, {
    algorithm: 'ES256', issuer: 'finvault-auth-service', audience: 'finvault-payment-service', expiresIn: seconds
  });
  const token = sign(60);
  const invoke = (headers: object, body: object) => {
    const req: any = { headers, body };
    let status = 200, response: any, next = false;
    const res: any = { status(code: number) { status = code; return this; }, json(value: any) { response = value; return this; } };
    requireTransactionToken(req, res, () => { next = true; });
    return { status, response, next, claims: req.transactionToken };
  };
  for (const [headers, body] of [[{}, { transactionToken: token }], [{ 'x-transaction-token': token }, {}]]) {
    const result = invoke(headers, body);
    assert.equal(result.next, true);
    assert.equal(result.claims.jti, payload.jti);
  }
  assert.equal(invoke({ 'x-transaction-token': token }, { transactionToken: sign(30) }).response.error.code, 'TXN_TOKEN_MISMATCH');
  assert.equal(invoke({}, { transactionToken: sign(120) }).response.error.code, 'TXN_TOKEN_MISMATCH');
  assert.equal(invoke({}, { transactionToken: sign(-5) }).response.error.code, 'TXN_TOKEN_EXPIRED');
});

test('both checkout contracts preserve exact amount strings and the idempotency header', () => {
  const destinationUserId = randomUUID();
  const generic = checkoutSchema.parse({ body: { type: 'WALLET_TRANSFER', destinationUserId, amount: '9007199254740993' } });
  assert.equal(generic.body.amount, '9007199254740993');
  const p2p = p2pCheckoutSchema.parse({ headers: { 'idempotency-key': 'checkout-1' }, body: { destinationUserId, amount: '50000' } });
  assert.equal(p2p.headers['idempotency-key'], 'checkout-1');
  assert.equal(p2p.body.destinationOwnerType, 'USER');
});
