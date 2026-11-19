import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { once } from 'node:events';
import express from 'express';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

process.env.ACCESS_TOKEN_SECRET = 'synthetic-gateway-regression';
const gatewayKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
process.env.GATEWAY_PRIVATE_KEY = gatewayKeys.privateKey;
process.env.GATEWAY_PUBLIC_KEY = gatewayKeys.publicKey;
for (const key of ['GATEWAY_PRIVATE_KEY_FILE', 'GATEWAY_PUBLIC_KEY_FILE', 'ACCESS_TOKEN_SECRET_FILE']) delete process.env[key];

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

const clientIdentityHeaders = [
  'x-gateway-token', 'x-internal-key', 'x-gateway-verified', 'x-user-id', 'x-user-role'
];
const forgedHeaders = (): Record<string, string> => ({
  'x-gateway-token': 'synthetic-client-gateway-token',
  'x-internal-key': 'synthetic-client-internal-key',
  'x-gateway-verified': 'true',
  'x-user-id': randomUUID(),
  'x-user-role': 'ADMIN'
});

async function gatewayPipeline(t: TestContext): Promise<string> {
  const { sanitizeHeaders } = await import('../src/middlewares/sanitizeHeaders');
  const { authenticate } = await import('../src/middlewares/authenticate');
  const app = express();
  app.use(sanitizeHeaders);
  app.use((req, res, next) => {
    // Observe the boundary before authenticate replaces identity headers.
    res.setHeader('x-test-clean-before-auth', String(clientIdentityHeaders.every(key => !(key in req.headers))));
    next();
  });
  app.use(authenticate);
  app.use((req, res) => {
    for (const name of ['x-gateway-token', 'x-user-id', 'x-user-role']) {
      const value = req.headers[name];
      if (typeof value === 'string') res.setHeader('x-test-observed-' + name, value);
    }
    res.setHeader('x-test-retained-internal-key', String('x-internal-key' in req.headers));
    res.setHeader('x-test-retained-static-flag', String('x-gateway-verified' in req.headers));
    res.status(204).end();
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('sanitized USER and ADMIN requests carry fresh signed identity from Bearer, never client headers', async t => {
  const origin = await gatewayPipeline(t);
  for (const role of ['USER', 'ADMIN']) {
    const owner = randomUUID();
    const bearer = jwt.sign({ userId: owner, role }, process.env.ACCESS_TOKEN_SECRET!, { expiresIn: 60 });
    const forged: Record<string, string> = { ...forgedHeaders(), 'x-user-role': role === 'USER' ? 'ADMIN' : 'USER' };
    const response = await fetch(origin + '/api/users/me', { headers: { ...forged, Authorization: 'Bearer ' + bearer } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('x-test-clean-before-auth'), 'true');
    assert.equal(response.headers.get('x-test-observed-x-user-id'), owner);
    assert.equal(response.headers.get('x-test-observed-x-user-role'), role);
    assert.equal(response.headers.get('x-test-retained-internal-key'), 'false');
    assert.equal(response.headers.get('x-test-retained-static-flag'), 'false');
    const token = response.headers.get('x-test-observed-x-gateway-token');
    assert.ok(token && token !== forged['x-gateway-token']);
    const claims = jwt.verify(token, gatewayKeys.publicKey, {
      algorithms: ['ES256'], issuer: 'finvault-gateway', audience: 'finvault-internal-services'
    });
    assert.ok(typeof claims === 'object');
    assert.equal(claims.sub, owner);
    assert.equal(claims.role, role);
    assert.ok(typeof claims.exp === 'number' && typeof claims.iat === 'number');
    assert.equal(claims.exp - claims.iat, 60);
  }
});

test('public callbacks also strip forged service headers without minting a user identity', async t => {
  const origin = await gatewayPipeline(t);
  const response = await fetch(origin + '/api/funding/vnpay/ipn', { headers: forgedHeaders() });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('x-test-clean-before-auth'), 'true');
  for (const name of ['x-gateway-token', 'x-user-id', 'x-user-role']) {
    assert.equal(response.headers.get('x-test-observed-' + name), null);
  }
  assert.equal(response.headers.get('x-test-retained-internal-key'), 'false');
  assert.equal(response.headers.get('x-test-retained-static-flag'), 'false');
});

test('forged identity headers cannot replace a missing or invalid Bearer on funding routes', async t => {
  const origin = await gatewayPipeline(t);
  for (const bearer of [undefined, 'synthetic-invalid-bearer']) {
    const headers = forgedHeaders();
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    const response = await fetch(origin + '/api/funding/cash-out', { method: 'POST', headers });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('x-test-clean-before-auth'), 'true');
    await response.arrayBuffer();
  }
});
