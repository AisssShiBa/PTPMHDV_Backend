import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient, OwnerType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { createTestGatewayToken } from 'finvault-internal-auth';

const prisma = new PrismaClient();

async function createTestWallet(balance: number, kycTier = 2) {
  const userId = randomUUID();
  const wallet = await prisma.wallet.create({
    data: {
      userId,
      balance,
      heldBalance: 0,
      currency: 'VND',
      ownerType: OwnerType.USER,
      kycTier,
    },
  });
  return { userId, wallet };
}

test('K15-1: GET /api/wallets/me trả đúng số dư và thông tin ví của chính user gọi', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const { userId, wallet } = await createTestWallet(250000);
    const token = createTestGatewayToken(userId, 'USER');

    const res = await fetch(`${baseUrl}/api/wallets/me`, {
      method: 'GET',
      headers: {
        'x-gateway-token': token,
      },
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.id, wallet.id);
    assert.equal(json.data.userId, userId);
    assert.equal(json.data.balance, '250000.00');
    assert.equal(json.data.heldBalance, '0.00');
    assert.equal(json.data.availableBalance, '250000.00');
    assert.equal(json.data.currency, 'VND');
    assert.equal(json.data.status, 'ACTIVE');
    assert.ok(json.data.createdAt);
    assert.ok(json.data.updatedAt);
  } finally {
    server.close();
  }
});

test('K15-1: Truyền query ?userId=nguoi_khac bị lờ đi, vẫn ra ví của chính user gọi', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const userA = await createTestWallet(500000);
    const userB = await createTestWallet(100000);

    const tokenA = createTestGatewayToken(userA.userId, 'USER');

    // User A gọi /me nhưng kèm ?userId=userB.userId
    const res = await fetch(`${baseUrl}/api/wallets/me?userId=${userB.userId}`, {
      method: 'GET',
      headers: {
        'x-gateway-token': tokenA,
      },
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    // Vẫn trả về ví của user A
    assert.equal(json.data.id, userA.wallet.id);
    assert.equal(json.data.userId, userA.userId);
    assert.equal(json.data.balance, '500000.00');
    assert.notEqual(json.data.userId, userB.userId);
  } finally {
    server.close();
  }
});

test('K15-1: Không có gateway token hoặc token rỗng -> 401', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Không truyền header
    const resNoHeader = await fetch(`${baseUrl}/api/wallets/me`, {
      method: 'GET',
    });
    assert.equal(resNoHeader.status, 401);
    const jsonNoHeader = await resNoHeader.json();
    assert.equal(jsonNoHeader.success, false);
    assert.equal(jsonNoHeader.error.code, 'UNAUTHORIZED');

    // 2. Token rỗng
    const resEmptyHeader = await fetch(`${baseUrl}/api/wallets/me`, {
      method: 'GET',
      headers: {
        'x-gateway-token': '',
      },
    });
    assert.equal(resEmptyHeader.status, 401);
    const jsonEmptyHeader = await resEmptyHeader.json();
    assert.equal(jsonEmptyHeader.success, false);
  } finally {
    server.close();
  }
});

test('K15-1: Token giả mạo (sai chữ ký ES256 hoặc chuỗi rác) -> 401', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const fakeToken = 'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3OC0xMjM0LTEyMzQtMTIzNC0xMjM0NTY3ODEyMzQiLCJyb2xlIjoiVVNFUiJ9.fake_signature';

    const res = await fetch(`${baseUrl}/api/wallets/me`, {
      method: 'GET',
      headers: {
        'x-gateway-token': fakeToken,
      },
    });

    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.success, false);
    assert.equal(json.error.code, 'INVALID_GATEWAY_TOKEN');
  } finally {
    server.close();
  }
});

test('K15-1: User chưa có ví -> trả 404 WALLET_NOT_FOUND theo hợp đồng v2', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const nonExistentUserId = randomUUID();
    const token = createTestGatewayToken(nonExistentUserId, 'USER');

    const res = await fetch(`${baseUrl}/api/wallets/me`, {
      method: 'GET',
      headers: {
        'x-gateway-token': token,
      },
    });

    assert.equal(res.status, 404);
    const json = await res.json();
    assert.equal(json.success, false);
    assert.equal(json.error.code, 'WALLET_NOT_FOUND');
    assert.ok(json.error.message);
  } finally {
    server.close();
  }
});
