import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient, OwnerType, LedgerDirection, TransferType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { createTestGatewayToken } from 'finvault-internal-auth';

const prisma = new PrismaClient();

test('K15-4: Bản thân file openapi.json hợp lệ theo chuẩn OpenAPI 3.0.3 và hợp đồng v2', () => {
  const openapiPath = path.resolve(__dirname, '../docs/openapi.json');
  assert.ok(fs.existsSync(openapiPath), 'File openapi.json phải tồn tại');

  const content = fs.readFileSync(openapiPath, 'utf-8');
  let openapi: any;
  assert.doesNotThrow(() => {
    openapi = JSON.parse(content);
  }, 'File openapi.json phải là JSON hợp lệ');

  // Kiểm tra thông tin cốt lõi
  assert.equal(openapi.openapi, '3.0.3');
  assert.ok(openapi.info?.title);
  assert.ok(openapi.info?.version);

  // Kiểm tra định nghĩa hai endpoint mới
  assert.ok(openapi.paths['/wallets/me']?.get, 'Phải có GET /wallets/me');
  assert.ok(openapi.paths['/wallets/me/ledger']?.get, 'Phải có GET /wallets/me/ledger');

  // Kiểm tra tham số của /wallets/me/ledger
  const ledgerParams = openapi.paths['/wallets/me/ledger'].get.parameters;
  const paramNames = ledgerParams.map((p: any) => p.name);
  assert.ok(paramNames.includes('limit'), 'Ledger API phải có tham số query limit');
  assert.ok(paramNames.includes('cursor'), 'Ledger API phải có tham số query cursor');

  // Kiểm tra schemas trong components
  const schemas = openapi.components?.schemas;
  assert.ok(schemas?.WalletBalance, 'Phải có schema WalletBalance');
  assert.ok(schemas?.WalletBalanceResponse, 'Phải có schema WalletBalanceResponse');
  assert.ok(schemas?.LedgerEntryItem, 'Phải có schema LedgerEntryItem');
  assert.ok(schemas?.WalletLedgerResponse, 'Phải có schema WalletLedgerResponse');
  assert.ok(schemas?.ErrorResponse, 'Phải có schema ErrorResponse');

  // Kiểm tra security scheme
  assert.ok(openapi.components?.securitySchemes?.bearerAuth, 'Phải có securityScheme bearerAuth');
  assert.ok(openapi.components?.securitySchemes?.gatewayToken, 'Phải có securityScheme gatewayToken');
});

test('K15-4: Validate response thực tế của GET /api/wallets/me khớp 100% schema OpenAPI và hợp đồng v2', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const openapiPath = path.resolve(__dirname, '../docs/openapi.json');
  const openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf-8'));
  const balanceSchema = openapi.components.schemas.WalletBalance;

  try {
    const userId = randomUUID();
    await prisma.wallet.create({
      data: {
        userId,
        balance: 750000.50,
        heldBalance: 50000.00,
        currency: 'VND',
        ownerType: OwnerType.USER,
        kycTier: 1,
      },
    });

    const token = createTestGatewayToken(userId, 'USER');

    const res = await fetch(`${baseUrl}/api/wallets/me`, {
      method: 'GET',
      headers: { 'x-gateway-token': token },
    });

    assert.equal(res.status, 200);
    const body = await res.json();

    // 1. Validate envelope
    assert.equal(body.success, true);
    assert.ok(body.data);

    // 2. Validate tất cả các trường bắt buộc theo schema
    for (const requiredProp of balanceSchema.required) {
      assert.ok(
        body.data[requiredProp] !== undefined && body.data[requiredProp] !== null,
        `Trường ${requiredProp} bắt buộc phải có trong response data`
      );
    }

    // 3. Validate kiểu dữ liệu
    assert.equal(typeof body.data.id, 'number');
    assert.equal(typeof body.data.userId, 'string');
    assert.equal(typeof body.data.balance, 'string');
    assert.equal(typeof body.data.heldBalance, 'string');
    assert.equal(typeof body.data.availableBalance, 'string');
    assert.equal(typeof body.data.currency, 'string');
    assert.ok(['ACTIVE', 'LOCKED'].includes(body.data.status));
    assert.ok(!isNaN(new Date(body.data.createdAt).getTime()));
    assert.ok(!isNaN(new Date(body.data.updatedAt).getTime()));

    // 4. Validate định dạng tiền tệ (chuỗi 2 chữ số thập phân)
    assert.match(body.data.balance, /^\d+\.\d{2}$/, 'balance phải có đúng 2 chữ số thập phân');
    assert.match(body.data.heldBalance, /^\d+\.\d{2}$/, 'heldBalance phải có đúng 2 chữ số thập phân');
    assert.match(body.data.availableBalance, /^\d+\.\d{2}$/, 'availableBalance phải có đúng 2 chữ số thập phân');

    // 5. Validate logic toán học số dư
    assert.equal(body.data.balance, '750000.50');
    assert.equal(body.data.heldBalance, '50000.00');
    assert.equal(body.data.availableBalance, '700000.50');
  } finally {
    server.close();
  }
});

test('K15-4: Validate response thực tế của GET /api/wallets/me/ledger khớp 100% schema OpenAPI và hợp đồng v2', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const openapiPath = path.resolve(__dirname, '../docs/openapi.json');
  const openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf-8'));
  const ledgerItemSchema = openapi.components.schemas.LedgerEntryItem;

  try {
    const userId = randomUUID();
    const wallet = await prisma.wallet.create({
      data: {
        userId,
        balance: 200000,
        heldBalance: 0,
        currency: 'VND',
        ownerType: OwnerType.USER,
        kycTier: 2,
      },
    });

    // Tạo 3 bút toán mẫu
    for (let i = 0; i < 3; i++) {
      await prisma.ledgerEntry.create({
        data: {
          transactionId: randomUUID(),
          walletId: wallet.id,
          direction: LedgerDirection.CREDIT,
          amount: 50000,
          balanceAfter: (i + 1) * 50000,
          referenceId: `contract_ref_${wallet.id}_${i}_${randomUUID()}`,
          transferType: TransferType.TOPUP,
          note: `Bút toán test hợp đồng ${i}`,
          createdAt: new Date(Date.now() - (3 - i) * 1000),
        },
      });
    }

    const token = createTestGatewayToken(userId, 'USER');

    const res = await fetch(`${baseUrl}/api/wallets/me/ledger?limit=2`, {
      method: 'GET',
      headers: { 'x-gateway-token': token },
    });

    assert.equal(res.status, 200);
    const body = await res.json();

    // 1. Validate envelope
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.data.items));
    assert.equal(body.data.items.length, 2);
    assert.equal(typeof body.data.nextCursor, 'string');

    // 2. Validate từng item theo schema OpenAPI
    for (const item of body.data.items) {
      for (const requiredProp of ledgerItemSchema.required) {
        assert.ok(
          item[requiredProp] !== undefined && item[requiredProp] !== null,
          `Trường ${requiredProp} bắt buộc phải có trong LedgerEntryItem`
        );
      }

      assert.equal(typeof item.id, 'string');
      assert.match(item.transactionId, /^[0-9a-f-]{36}$/i);
      assert.ok(['DEBIT', 'CREDIT'].includes(item.direction));
      assert.match(item.amount, /^\d+\.\d{2}$/);
      assert.match(item.balanceAfter, /^\d+\.\d{2}$/);
      assert.equal(typeof item.referenceId, 'string');
      assert.ok(['TOPUP', 'PAYMENT', 'REFUND', 'P2P_TRANSFER', 'ADJUSTMENT'].includes(item.transferType));
      assert.ok(!isNaN(new Date(item.createdAt).getTime()));

      // 3. Chống lộ thông tin tuyệt đối
      assert.equal(item.walletId, undefined, 'Không được lộ walletId');
      assert.equal(item.userId, undefined, 'Không được lộ userId');
    }
  } finally {
    server.close();
  }
});

test('K15-4: Validate schema response lỗi 400, 401, 404 khớp chuẩn ErrorResponse OpenAPI', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Lỗi 401: Không có auth header
    const res401 = await fetch(`${baseUrl}/api/wallets/me`);
    assert.equal(res401.status, 401);
    const body401 = await res401.json();
    assert.equal(body401.success, false);
    assert.ok(body401.error?.code);
    assert.ok(body401.error?.message);

    // 2. Lỗi 400: Cursor bậy (với user đã có ví)
    const userWithWallet = await prisma.wallet.create({
      data: {
        userId: randomUUID(),
        balance: 100000,
        currency: 'VND',
        ownerType: OwnerType.USER,
      },
    });
    const token = createTestGatewayToken(userWithWallet.userId!, 'USER');
    const res400 = await fetch(`${baseUrl}/api/wallets/me/ledger?cursor=invalid_cursor_xyz`, {
      headers: { 'x-gateway-token': token },
    });
    assert.equal(res400.status, 400);
    const body400 = await res400.json();
    assert.equal(body400.success, false);
    assert.equal(body400.error?.code, 'INVALID_CURSOR');
    assert.ok(body400.error?.message);

    // 3. Lỗi 404: User chưa có ví
    const nonExistentUserId = randomUUID();
    const tokenNonExistent = createTestGatewayToken(nonExistentUserId, 'USER');
    const res404 = await fetch(`${baseUrl}/api/wallets/me`, {
      headers: { 'x-gateway-token': tokenNonExistent },
    });
    assert.equal(res404.status, 404);
    const body404 = await res404.json();
    assert.equal(body404.success, false);
    assert.equal(body404.error?.code, 'WALLET_NOT_FOUND');
    assert.ok(body404.error?.message);
  } finally {
    server.close();
  }
});
