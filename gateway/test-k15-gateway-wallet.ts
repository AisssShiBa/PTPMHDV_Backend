import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import http from 'http';
let sanitizeHeaders: typeof import('./src/middlewares/sanitizeHeaders').sanitizeHeaders;
let authenticate: typeof import('./src/middlewares/authenticate').authenticate;
let env: typeof import('./src/config/services').env;
let verifyGatewayToken: typeof import('./src/utils/gatewayToken').verifyGatewayToken;
const previousEnvironment = new Map<string, string | undefined>();

before(async () => {
  const keys = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const testEnvironment: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    GATEWAY_PRIVATE_KEY: keys.privateKey,
    GATEWAY_PUBLIC_KEY: keys.publicKey,
    ACCESS_TOKEN_SECRET: randomBytes(32).toString('hex'),
    INTERNAL_KEY: 'synthetic-k15-test-key',
    REDIS_URL: 'redis://127.0.0.1:1',
    GATEWAY_PRIVATE_KEY_FILE: undefined,
    GATEWAY_PUBLIC_KEY_FILE: undefined,
    ACCESS_TOKEN_SECRET_FILE: undefined,
    INTERNAL_KEY_FILE: undefined,
    REDIS_URL_FILE: undefined,
  };
  for (const [key, value] of Object.entries(testEnvironment)) {
    previousEnvironment.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // Delay imports so module configuration cannot read deployment credentials.
  ({ sanitizeHeaders } = await import('./src/middlewares/sanitizeHeaders'));
  ({ authenticate } = await import('./src/middlewares/authenticate'));
  ({ env } = await import('./src/config/services'));
  ({ verifyGatewayToken } = await import('./src/utils/gatewayToken'));
});

after(() => {
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('K15-3: SanitizeHeaders loại bỏ triệt để mọi header giả mạo từ client', () => {
  const req: any = {
    headers: {
      'x-user-id': 'spoofed_user_123',
      'x-user-role': 'ADMIN',
      'x-gateway-verified': 'true',
      'x-gateway-token': 'spoofed_gateway_token',
      'x-internal-key': 'spoofed_internal_key',
      'authorization': 'Bearer some_token',
    },
  };
  let nextCalled = false;
  sanitizeHeaders(req, {} as any, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(req.headers['x-user-id'], undefined, 'x-user-id phải bị xóa');
  assert.equal(req.headers['x-user-role'], undefined, 'x-user-role phải bị xóa');
  assert.equal(req.headers['x-gateway-verified'], undefined, 'x-gateway-verified phải bị xóa');
  assert.equal(req.headers['x-gateway-token'], undefined, 'x-gateway-token phải bị xóa');
  assert.equal(req.headers['x-internal-key'], undefined, 'x-internal-key phải bị xóa');
  assert.equal(req.headers['authorization'], 'Bearer some_token', 'authorization header được giữ lại để authenticate');
});

test('K15-3: Authenticate middleware - Không có token hoặc token sai -> 401', () => {
  // 1. Không có token
  const reqNoAuth: any = { path: '/api/wallets/me', method: 'GET', headers: {} };
  const resNoAuth: any = {
    statusCode: 200,
    status(c: number) { this.statusCode = c; return this; },
    json(d: any) { this.data = d; return this; },
  };
  authenticate(reqNoAuth, resNoAuth, () => {});
  assert.equal(resNoAuth.statusCode, 401);
  assert.equal(resNoAuth.data?.error?.code, 'UNAUTHORIZED');

  // 2. Token sai / hết hạn
  const reqBadToken: any = {
    path: '/api/wallets/me',
    method: 'GET',
    headers: { authorization: 'Bearer invalid_signature_token' },
  };
  const resBadToken: any = {
    statusCode: 200,
    status(c: number) { this.statusCode = c; return this; },
    json(d: any) { this.data = d; return this; },
  };
  authenticate(reqBadToken, resBadToken, () => {});
  assert.equal(resBadToken.statusCode, 401);
  assert.equal(resBadToken.data?.error?.code, 'INVALID_TOKEN');
});

test('K15-3: Authenticate middleware - Access Token hợp lệ sinh x-gateway-token ES256 với đúng claims', () => {
  const userId = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';
  const role = 'USER';
  const kycTier = 1;

  const clientToken = jwt.sign(
    { userId, role, kycTier },
    env.accessTokenSecret,
    { expiresIn: '15m' }
  );

  const req: any = {
    path: '/api/wallets/me',
    method: 'GET',
    headers: { authorization: `Bearer ${clientToken}` },
  };
  let nextCalled = false;
  const res: any = {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json(data: unknown) { this.data = data; return this; },
  };
  authenticate(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.ok(req.headers['x-gateway-token'], 'Phải sinh header x-gateway-token');

  // Verify lại gateway token bằng public key của gateway
  const verified = verifyGatewayToken(req.headers['x-gateway-token']);
  assert.equal(verified.sub, userId);
  assert.equal(verified.role, role);
  // M17: Wallet owns KYC; Gateway must not copy a client-supplied tier.
  assert.equal(verified.kycTier, 0);
});

test('K15-3: Gateway proxy with mock Wallet forwards identity and strips forged headers', async t => {
  // Khởi tạo một mock backend service lắng nghe request từ Gateway
  let receivedHeaders: Record<string, string | string[] | undefined> = {};
  let receivedUrl = '';

  const mockWalletServer = http.createServer((req, res) => {
    receivedHeaders = req.headers;
    receivedUrl = req.url || '';

    if (req.url === '/api/wallets/me') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: {
          id: 101,
          userId: 'user_from_mock',
          balance: '500000.00',
          currency: 'VND',
        },
      }));
      return;
    }

    if (req.url?.startsWith('/api/wallets/me/ledger')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: {
          items: [],
          nextCursor: null,
        },
      }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const closeServer = (server: http.Server) => new Promise<void>((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close(error => error ? reject(error) : resolve());
  });
  t.after(() => closeServer(mockWalletServer));

  await new Promise<void>((resolve) => mockWalletServer.listen(0, resolve));
  const mockAddress = mockWalletServer.address();
  assert.ok(mockAddress && typeof mockAddress !== 'string');
  const mockPort = mockAddress.port;

  // Cấu hình tạm WALLET_SERVICE_URL của env sang mock port
  const originalWalletUrl = env.services.wallet;
  env.services.wallet = `http://127.0.0.1:${mockPort}`;
  t.after(() => { env.services.wallet = originalWalletUrl; });

  // Import app của gateway
  const appModule = await import('./src/app');
  const { redisClient } = await import('./src/config/redis');
  t.after(() => { redisClient.disconnect(); });
  const gatewayApp = appModule.default;
  const gatewayServer = gatewayApp.listen(0);
  t.after(() => closeServer(gatewayServer));
  const gatewayAddress = gatewayServer.address();
  assert.ok(gatewayAddress && typeof gatewayAddress !== 'string');
  const gatewayPort = gatewayAddress.port;
  const gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}`;

  try {
    const userId = '11111111-2222-3333-4444-555555555555';
    const clientToken = jwt.sign(
      { userId, role: 'USER', kycTier: 0 },
      env.accessTokenSecret,
      { expiresIn: '15m' }
    );

    // 1. Gọi /api/wallets/me qua Gateway kèm các header giả mạo
    const res = await fetch(`${gatewayBaseUrl}/api/wallets/me`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${clientToken}`,
        'x-user-id': 'hacker_spoofed_user',
        'x-user-role': 'ADMIN',
        'x-gateway-token': 'forged-gateway-token',
        'x-gateway-verified': 'true',
        'x-internal-key': 'hacker_secret',
      },
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.id, 101);

    // Kiểm tra header nhận được ở backend service con
    assert.equal(receivedUrl, '/api/wallets/me');
    assert.ok(receivedHeaders['x-gateway-token'], 'Service con phải nhận được x-gateway-token');
    assert.equal(receivedHeaders['x-gateway-verified'], undefined, 'x-gateway-verified giả mạo phải bị gỡ');
    assert.equal(receivedHeaders['x-internal-key'], undefined, 'x-internal-key giả mạo phải bị gỡ');

    // Giải mã x-gateway-token mà mock backend nhận được:
    const backendVerified = verifyGatewayToken(receivedHeaders['x-gateway-token'] as string);
    assert.equal(backendVerified.sub, userId, 'Sub trong x-gateway-token phải khớp đúng danh tính token của user');
    assert.equal(backendVerified.role, 'USER');
    assert.equal(receivedHeaders['x-user-id'], userId);
    assert.equal(receivedHeaders['x-user-role'], 'USER');

    // 2. Gọi /api/wallets/me/ledger?limit=10 qua Gateway
    const resLedger = await fetch(`${gatewayBaseUrl}/api/wallets/me/ledger?limit=10`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${clientToken}`,
      },
    });

    assert.equal(resLedger.status, 200);
    const ledger = await resLedger.json();
    assert.deepEqual(ledger.data, { items: [], nextCursor: null });
    assert.equal(receivedUrl, '/api/wallets/me/ledger?limit=10', 'Query parameters phải được forward đầy đủ');
  } finally {
    await closeServer(gatewayServer);
    await closeServer(mockWalletServer);
  }
});
