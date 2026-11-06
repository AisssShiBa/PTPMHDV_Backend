import assert from 'node:assert/strict';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import http from 'http';
import { sanitizeHeaders } from './src/middlewares/sanitizeHeaders';
import { authenticate } from './src/middlewares/authenticate';
import { env } from './src/config/services';
import { verifyGatewayToken } from './src/utils/gatewayToken';

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
  authenticate(req, {} as any, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.ok(req.headers['x-gateway-token'], 'Phải sinh header x-gateway-token');

  // Verify lại gateway token bằng public key của gateway
  const verified = verifyGatewayToken(req.headers['x-gateway-token']);
  assert.equal(verified.sub, userId);
  assert.equal(verified.role, role);
  assert.equal(verified.kycTier, kycTier);
});

test('K15-3: End-to-end Gateway Proxy tới Wallet Service - chuyển tiếp token, lọc header giả', async () => {
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

  await new Promise<void>((resolve) => mockWalletServer.listen(0, resolve));
  const mockPort = (mockWalletServer.address() as any).port;

  // Cấu hình tạm WALLET_SERVICE_URL của env sang mock port
  const originalWalletUrl = env.services.wallet;
  (env.services as any).wallet = `http://127.0.0.1:${mockPort}`;

  // Import app của gateway
  const appModule = await import('./src/app');
  const gatewayApp = appModule.default;
  const gatewayServer = gatewayApp.listen(0);
  const gatewayPort = (gatewayServer.address() as any).port;
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

    // 2. Gọi /api/wallets/me/ledger?limit=10 qua Gateway
    const resLedger = await fetch(`${gatewayBaseUrl}/api/wallets/me/ledger?limit=10`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${clientToken}`,
      },
    });

    assert.equal(resLedger.status, 200);
    assert.equal(receivedUrl, '/api/wallets/me/ledger?limit=10', 'Query parameters phải được forward đầy đủ');
  } finally {
    (env.services as any).wallet = originalWalletUrl;
    gatewayServer.close();
    mockWalletServer.close();
  }
});
