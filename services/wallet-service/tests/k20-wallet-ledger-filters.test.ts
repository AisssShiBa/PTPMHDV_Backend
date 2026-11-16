import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient, OwnerType, TransferType, LedgerDirection } from '@prisma/client';
import { randomUUID } from 'crypto';
import { createTestGatewayToken } from 'finvault-internal-auth';
import fs from 'node:fs';
import path from 'node:path';

const prisma = new PrismaClient();

async function createTestWalletWithFilterEntries() {
  const userId = randomUUID();
  const wallet = await prisma.wallet.create({
    data: {
      userId,
      balance: 1000000,
      heldBalance: 0,
      currency: 'VND',
      ownerType: OwnerType.USER,
      kycTier: 2,
    },
  });

  // Tạo các bút toán theo ngày và loại cụ thể
  // Giờ Việt Nam UTC+7: 2026-11-01, 2026-11-02, 2026-11-03
  const d1 = new Date('2026-11-01T10:00:00.000+07:00');
  const d2 = new Date('2026-11-02T14:30:00.000+07:00');
  const d3 = new Date('2026-11-03T09:15:00.000+07:00');

  // Entry 1: Day 1 - CREDIT - TOPUP
  const e1 = await prisma.ledgerEntry.create({
    data: {
      transactionId: randomUUID(),
      walletId: wallet.id,
      direction: LedgerDirection.CREDIT,
      amount: 500000,
      balanceAfter: 500000,
      referenceId: `ref_k20_topup_${randomUUID()}`,
      transferType: TransferType.TOPUP,
      note: 'Nạp tiền vào ví ngày 1',
      createdAt: d1,
    },
  });

  // Entry 2: Day 2 - DEBIT - P2P_TRANSFER
  const e2 = await prisma.ledgerEntry.create({
    data: {
      transactionId: randomUUID(),
      walletId: wallet.id,
      direction: LedgerDirection.DEBIT,
      amount: 100000,
      balanceAfter: 400000,
      referenceId: `ref_k20_p2p_${randomUUID()}`,
      transferType: TransferType.P2P_TRANSFER,
      note: 'Chuyển tiền ăn trưa ngày 2',
      createdAt: d2,
    },
  });

  // Entry 3: Day 3 - DEBIT - PAYMENT
  const e3 = await prisma.ledgerEntry.create({
    data: {
      transactionId: randomUUID(),
      walletId: wallet.id,
      direction: LedgerDirection.DEBIT,
      amount: 50000,
      balanceAfter: 350000,
      referenceId: `ref_k20_pay_${randomUUID()}`,
      transferType: TransferType.PAYMENT,
      note: 'Thanh toán tiền điện ngày 3',
      createdAt: d3,
    },
  });

  return { userId, wallet, entries: [e1, e2, e3] };
}

test('K20 (1): OpenAPI contract chứa đầy đủ tham số bộ lọc cho /wallets/me/ledger', () => {
  const openapiPath = path.resolve(__dirname, '../docs/openapi.json');
  const openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf-8'));
  const ledgerParams = openapi.paths['/wallets/me/ledger'].get.parameters;
  const paramNames = ledgerParams.map((p: any) => p.name);

  assert.ok(paramNames.includes('limit'), 'Phải có tham số limit');
  assert.ok(paramNames.includes('cursor'), 'Phải có tham số cursor');
  assert.ok(paramNames.includes('startDate'), 'Phải có tham số startDate');
  assert.ok(paramNames.includes('endDate'), 'Phải có tham số endDate');
  assert.ok(paramNames.includes('type'), 'Phải có tham số type');
  assert.ok(paramNames.includes('direction'), 'Phải có tham số direction');
});

test('K20 (2): Lọc theo loại giao dịch (type)', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const { userId } = await createTestWalletWithFilterEntries();
    const token = createTestGatewayToken(userId, 'USER');

    // 1. Lọc type=TOPUP
    const resTopup = await fetch(`${baseUrl}/api/wallets/me/ledger?type=TOPUP`, {
      headers: { 'x-gateway-token': token },
    });
    assert.equal(resTopup.status, 200);
    const bodyTopup = await resTopup.json();
    assert.equal(bodyTopup.success, true);
    assert.equal(bodyTopup.data.items.length, 1);
    assert.equal(bodyTopup.data.items[0].transferType, 'TOPUP');

    // 2. Lọc type=TRANSFER (chuẩn hóa sang P2P_TRANSFER)
    const resTransfer = await fetch(`${baseUrl}/api/wallets/me/ledger?type=TRANSFER`, {
      headers: { 'x-gateway-token': token },
    });
    assert.equal(resTransfer.status, 200);
    const bodyTransfer = await resTransfer.json();
    assert.equal(bodyTransfer.data.items.length, 1);
    assert.equal(bodyTransfer.data.items[0].transferType, 'P2P_TRANSFER');

    // 3. Lọc type=WITHDRAW (trả về danh sách rỗng an toàn, không sập)
    const resWithdraw = await fetch(`${baseUrl}/api/wallets/me/ledger?type=WITHDRAW`, {
      headers: { 'x-gateway-token': token },
    });
    assert.equal(resWithdraw.status, 200);
    const bodyWithdraw = await resWithdraw.json();
    assert.equal(bodyWithdraw.data.items.length, 0);
    assert.equal(bodyWithdraw.data.nextCursor, null);

    // 4. Lọc type không hợp lệ -> 400 INVALID_TYPE
    const resInvalid = await fetch(`${baseUrl}/api/wallets/me/ledger?type=HACK_INJECTION`, {
      headers: { 'x-gateway-token': token },
    });
    assert.equal(resInvalid.status, 400);
    const bodyInvalid = await resInvalid.json();
    assert.equal(bodyInvalid.error?.code, 'INVALID_TYPE');
  } finally {
    server.close();
  }
});

test('K20 (3): Lọc theo hướng dòng tiền (direction)', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const { userId } = await createTestWalletWithFilterEntries();
    const token = createTestGatewayToken(userId, 'USER');

    // 1. Lọc direction=CREDIT
    const resCredit = await fetch(`${baseUrl}/api/wallets/me/ledger?direction=CREDIT`, {
      headers: { 'x-gateway-token': token },
    });
    assert.equal(resCredit.status, 200);
    const bodyCredit = await resCredit.json();
    assert.equal(bodyCredit.data.items.length, 1);
    assert.equal(bodyCredit.data.items[0].direction, 'CREDIT');

    // 2. Lọc direction=DEBIT
    const resDebit = await fetch(`${baseUrl}/api/wallets/me/ledger?direction=DEBIT`, {
      headers: { 'x-gateway-token': token },
    });
    assert.equal(resDebit.status, 200);
    const bodyDebit = await resDebit.json();
    assert.equal(bodyDebit.data.items.length, 2);
    for (const item of bodyDebit.data.items) {
      assert.equal(item.direction, 'DEBIT');
    }

    // 3. Direction không hợp lệ -> 400 INVALID_DIRECTION
    const resInvalid = await fetch(`${baseUrl}/api/wallets/me/ledger?direction=UNKNOWN`, {
      headers: { 'x-gateway-token': token },
    });
    assert.equal(resInvalid.status, 400);
    const bodyInvalid = await resInvalid.json();
    assert.equal(bodyInvalid.error?.code, 'INVALID_DIRECTION');
  } finally {
    server.close();
  }
});

test('K20 (4): Lọc theo khoảng ngày (startDate, endDate) theo chuẩn UTC+7', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const { userId } = await createTestWalletWithFilterEntries();
    const token = createTestGatewayToken(userId, 'USER');

    // 1. Lọc đúng ngày 2026-11-02 (chỉ có bút toán e2)
    const resD2 = await fetch(`${baseUrl}/api/wallets/me/ledger?startDate=2026-11-02&endDate=2026-11-02`, {
      headers: { 'x-gateway-token': token },
    });
    assert.equal(resD2.status, 200);
    const bodyD2 = await resD2.json();
    assert.equal(bodyD2.data.items.length, 1);
    assert.equal(bodyD2.data.items[0].note, 'Chuyển tiền ăn trưa ngày 2');

    // 2. Lọc từ 2026-11-02 đến 2026-11-03 (có bút toán e2 và e3)
    const resD23 = await fetch(`${baseUrl}/api/wallets/me/ledger?startDate=2026-11-02&endDate=2026-11-03`, {
      headers: { 'x-gateway-token': token },
    });
    assert.equal(resD23.status, 200);
    const bodyD23 = await resD23.json();
    assert.equal(bodyD23.data.items.length, 2);

    // 3. startDate lớn hơn endDate -> 400 INVALID_DATE_RANGE
    const resReversed = await fetch(`${baseUrl}/api/wallets/me/ledger?startDate=2026-11-05&endDate=2026-11-01`, {
      headers: { 'x-gateway-token': token },
    });
    assert.equal(resReversed.status, 400);
    const bodyReversed = await resReversed.json();
    assert.equal(bodyReversed.error?.code, 'INVALID_DATE_RANGE');

    // 4. Định dạng ngày sai -> 400 INVALID_DATE_FORMAT
    const resInvalidDate = await fetch(`${baseUrl}/api/wallets/me/ledger?startDate=not-a-date`, {
      headers: { 'x-gateway-token': token },
    });
    assert.equal(resInvalidDate.status, 400);
    const bodyInvalidDate = await resInvalidDate.json();
    assert.equal(bodyInvalidDate.error?.code, 'INVALID_DATE_FORMAT');
  } finally {
    server.close();
  }
});

test('K20 (5): Phân trang Keyset kết hợp bộ lọc không làm mất điều kiện lọc ở trang tiếp theo', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const userId = randomUUID();
    const wallet = await prisma.wallet.create({
      data: {
        userId,
        balance: 500000,
        heldBalance: 0,
        currency: 'VND',
        ownerType: OwnerType.USER,
        kycTier: 2,
      },
    });

    // Tạo 5 bút toán CREDIT và 2 bút toán DEBIT xen kẽ
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await prisma.ledgerEntry.create({
        data: {
          transactionId: randomUUID(),
          walletId: wallet.id,
          direction: LedgerDirection.CREDIT,
          amount: 10000 * (i + 1),
          balanceAfter: 10000 * (i + 1),
          referenceId: `ref_k20_credit_${i}_${randomUUID()}`,
          transferType: TransferType.TOPUP,
          note: `Bút toán CREDIT ${i + 1}`,
          createdAt: new Date(now + i * 1000),
        },
      });
    }

    for (let i = 0; i < 2; i++) {
      await prisma.ledgerEntry.create({
        data: {
          transactionId: randomUUID(),
          walletId: wallet.id,
          direction: LedgerDirection.DEBIT,
          amount: 5000,
          balanceAfter: 45000,
          referenceId: `ref_k20_debit_${i}_${randomUUID()}`,
          transferType: TransferType.PAYMENT,
          note: `Bút toán DEBIT ${i + 1}`,
          createdAt: new Date(now + 10000 + i * 1000),
        },
      });
    }

    const token = createTestGatewayToken(userId, 'USER');

    // Trang 1: limit=2, direction=CREDIT
    const res1 = await fetch(`${baseUrl}/api/wallets/me/ledger?direction=CREDIT&limit=2`, {
      headers: { 'x-gateway-token': token },
    });
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.data.items.length, 2);
    assert.ok(body1.data.nextCursor);
    for (const item of body1.data.items) {
      assert.equal(item.direction, 'CREDIT');
    }

    // Trang 2: cursor=cursor1, giữ nguyên direction=CREDIT&limit=2
    const res2 = await fetch(`${baseUrl}/api/wallets/me/ledger?direction=CREDIT&limit=2&cursor=${body1.data.nextCursor}`, {
      headers: { 'x-gateway-token': token },
    });
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.data.items.length, 2);
    assert.ok(body2.data.nextCursor);
    for (const item of body2.data.items) {
      assert.equal(item.direction, 'CREDIT');
    }

    // Trang 3: lấy phần tử cuối cùng
    const res3 = await fetch(`${baseUrl}/api/wallets/me/ledger?direction=CREDIT&limit=2&cursor=${body2.data.nextCursor}`, {
      headers: { 'x-gateway-token': token },
    });
    assert.equal(res3.status, 200);
    const body3 = await res3.json();
    assert.equal(body3.data.items.length, 1);
    assert.equal(body3.data.nextCursor, null);
    assert.equal(body3.data.items[0].direction, 'CREDIT');

    // Đảm bảo không trùng lặp giữa các trang
    const allIds = [
      ...body1.data.items.map((it: any) => it.id),
      ...body2.data.items.map((it: any) => it.id),
      ...body3.data.items.map((it: any) => it.id),
    ];
    assert.equal(allIds.length, 5);
    const uniqueIds = new Set(allIds);
    assert.equal(uniqueIds.size, 5, '5 bút toán phải phân biệt, không trùng lặp');
  } finally {
    server.close();
  }
});
