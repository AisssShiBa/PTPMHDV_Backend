import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

process.env.ACCESS_TOKEN_SECRET = 'synthetic-gateway-regression';
process.env.GATEWAY_PRIVATE_KEY = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;

test('only exact GET VNPAY callbacks are public; funding operations receive signed identity', async () => {
  const { authenticate } = await import('../src/middlewares/authenticate');
  const owner = randomUUID();
  const token = jwt.sign({ userId: owner, role: 'USER', kycTier: 0 }, process.env.ACCESS_TOKEN_SECRET!, { expiresIn: 60 });
  const invoke = (path: string, method: string, bearer?: string) => {
    const req: any = { path, method, headers: bearer ? { authorization: 'Bearer ' + bearer } : {} };
    const res: any = { statusCode: 200, status(value: number) { this.statusCode = value; return this; }, json(value: unknown) { this.data = value; return this; } };
    let passed = false;
    authenticate(req, res, () => { passed = true; });
    return { req, res, passed };
  };
  for (const prefix of ['/api/funding/vnpay', '/api/payments/topups/vnpay']) {
    for (const callback of ['ipn', 'return']) {
      assert.equal(invoke(prefix + '/' + callback, 'GET').passed, true);
      assert.equal(invoke(prefix + '/' + callback, 'POST').res.statusCode, 401);
      assert.equal(invoke(prefix + '/' + callback + '/extra', 'GET').res.statusCode, 401);
    }
  }
  for (const path of ['/api/funding/vnpay/create', '/api/funding/cash-out', '/api/funding/cash-out/' + randomUUID(), '/api/payments/topups/vnpay/create']) {
    for (const method of ['GET', 'POST']) {
      assert.equal(invoke(path, method).res.statusCode, 401);
      assert.equal(invoke(path, method, 'bad').res.statusCode, 401);
      const valid = invoke(path, method, token);
      assert.equal(valid.passed, true);
      assert.equal(valid.req.headers['x-user-id'], owner);
      assert.equal(typeof valid.req.headers['x-gateway-token'], 'string');
    }
  }
});
