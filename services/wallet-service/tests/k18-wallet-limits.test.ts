import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient, OwnerType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { createTestGatewayToken } from 'finvault-internal-auth';
import { seedLimitPolicies } from '../prisma/seed';
import { getVnDay, getVnMonthKey } from '../src/utils/timezone.helper';

const prisma = new PrismaClient();

test('K18: GET /api/wallets/me trả về đúng dailyLimit, dailyUsed, monthlyLimit, monthlyUsed thật từ DB', async () => {
  await seedLimitPolicies();

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
        balance: 1000000,
        heldBalance: 0,
        currency: 'VND',
        ownerType: OwnerType.USER,
        kycTier: 0, // Tier 0: perDay = 500.000, perMonth = 2.000.000
      },
    });

    const token = createTestGatewayToken(userId, 'USER');

    // 1. Kiểm tra ban đầu khi chưa có giao dịch nào
    const res1 = await fetch(`${baseUrl}/api/wallets/me`, {
      method: 'GET',
      headers: { 'x-gateway-token': token },
    });

    assert.equal(res1.status, 200);
    const json1 = await res1.json();
    assert.equal(json1.success, true);
    assert.equal(json1.data.userId, userId);
    assert.equal(json1.data.kycTier, 0);
    assert.equal(json1.data.dailyLimit, '500000.00');
    assert.equal(json1.data.dailyUsed, '0.00');
    assert.equal(json1.data.monthlyLimit, '2000000.00');
    assert.equal(json1.data.monthlyUsed, '0.00');

    // 2. Tạo một bản ghi tiêu tiền trong UserDailyUsage (150.000đ)
    const now = new Date();
    const day = getVnDay(now);
    const monthKey = getVnMonthKey(now);

    await prisma.userDailyUsage.create({
      data: {
        userId,
        day,
        monthKey,
        spentDay: 150000,
      },
    });

    // 3. Gọi lại GET /api/wallets/me -> dailyUsed và monthlyUsed phải cập nhật thành 150000.00
    const res2 = await fetch(`${baseUrl}/api/wallets/me`, {
      method: 'GET',
      headers: { 'x-gateway-token': token },
    });

    assert.equal(res2.status, 200);
    const json2 = await res2.json();
    assert.equal(json2.success, true);
    assert.equal(json2.data.dailyUsed, '150000.00');
    assert.equal(json2.data.monthlyUsed, '150000.00');
    assert.equal(json2.data.dailyLimit, '500000.00');
    assert.equal(json2.data.monthlyLimit, '2000000.00');
  } finally {
    server.close();
  }
});
