import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient, OwnerType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { createTestGatewayToken } from 'finvault-internal-auth';

const prisma = new PrismaClient();

const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';

const adminToken = () => createTestGatewayToken(ADMIN_ID, 'ADMIN');
const userToken = () => createTestGatewayToken(USER_ID, 'USER');

test('K17-1: Phân quyền - 401 khi thiếu token, 403 khi role USER, 200 khi role ADMIN', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Không có token -> 401
    const noTokenRes = await fetch(`${baseUrl}/api/wallets/admin/reconciliation`);
    assert.equal(noTokenRes.status, 401);

    // 2. Token USER -> 403
    const userRes = await fetch(`${baseUrl}/api/wallets/admin/reconciliation`, {
      headers: { 'x-gateway-token': userToken() },
    });
    assert.equal(userRes.status, 403);

    // 3. Token ADMIN -> 200
    const adminRes = await fetch(`${baseUrl}/api/wallets/admin/reconciliation`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(adminRes.status, 200);
    const json = await adminRes.json();
    assert.equal(json.success, true);
    assert.ok(json.data.id);
    assert.ok(Array.isArray(json.data.anomalies));

    // 4. Đường dẫn trực tiếp /reconciliation cũng hoạt động và yêu cầu ADMIN
    const directRes = await fetch(`${baseUrl}/reconciliation`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(directRes.status, 200);

    // 5. Query mode không hợp lệ -> 400 INVALID_MODE
    const badModeRes = await fetch(`${baseUrl}/api/wallets/admin/reconciliation?mode=invalid_xyz`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(badModeRes.status, 400);
    const badModeJson = await badModeRes.json();
    assert.equal(badModeJson.error.code, 'INVALID_MODE');
  } finally {
    server.close();
  }
});

test('K17-1: Cố ý làm lệch số dư một ví -> Đối soát phát hiện đúng BALANCE_DRIFT với số lệch chính xác', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // Tạo một ví test với số dư ban đầu 100000.00 và có bản ghi sổ cái hợp lệ
  const testUserId = randomUUID();
  const wallet = await prisma.wallet.create({
    data: {
      userId: testUserId,
      balance: 100000,
      heldBalance: 0,
      currency: 'VND',
      ownerType: OwnerType.USER,
      kycTier: 1,
    },
  });

  const txId = randomUUID();
  await prisma.ledgerEntry.create({
    data: {
      transactionId: txId,
      walletId: wallet.id,
      direction: 'CREDIT',
      amount: 100000,
      balanceAfter: 100000,
      referenceId: `seed_${randomUUID()}`,
      transferType: 'TOPUP',
    },
  });

  try {
    // 1. Kiểm tra trước khi làm lệch: không có drift trên ví này
    const beforeRes = await fetch(`${baseUrl}/api/wallets/admin/reconciliation?mode=quick`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    const beforeJson = await beforeRes.json();
    const driftBefore = beforeJson.data.anomalies.find((a: any) => a.walletId === wallet.id);
    assert.equal(driftBefore, undefined, 'Trước khi làm lệch, ví test không được có anomaly');

    // 2. Cố ý sửa tay cột balance trên DB test (+50000.00 VND)
    await prisma.wallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: 50000 } },
    });

    // 3. Chạy quick reconciliation
    const quickRes = await fetch(`${baseUrl}/api/wallets/admin/reconciliation?mode=quick`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(quickRes.status, 200);
    const quickJson = await quickRes.json();
    assert.equal(quickJson.data.mode, 'QUICK');

    const driftQuick = quickJson.data.anomalies.find((a: any) => a.walletId === wallet.id);
    assert.ok(driftQuick, 'Phải phát hiện BALANCE_DRIFT trên ví bị sửa');
    assert.equal(driftQuick.type, 'BALANCE_DRIFT');
    assert.equal(driftQuick.walletId, wallet.id);
    assert.equal(driftQuick.expected, '100000.00');
    assert.equal(driftQuick.actual, '150000.00');
    assert.equal(driftQuick.difference, '50000.00');
    assert.equal(driftQuick.status, 'OPEN');
    assert.equal(driftQuick.mode, 'QUICK');
    assert.ok(typeof driftQuick.id === 'string');
    assert.ok(driftQuick.reportId > 0);

    // 4. Chạy full reconciliation -> kết quả nhất quán
    const fullRes = await fetch(`${baseUrl}/api/wallets/admin/reconciliation?mode=full`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(fullRes.status, 200);
    const fullJson = await fullRes.json();
    assert.equal(fullJson.data.mode, 'FULL');

    const driftFull = fullJson.data.anomalies.find((a: any) => a.walletId === wallet.id);
    assert.ok(driftFull, 'Chế độ full cũng phải phát hiện BALANCE_DRIFT');
    assert.equal(driftFull.type, 'BALANCE_DRIFT');
    assert.equal(driftFull.walletId, wallet.id);
    assert.equal(driftFull.expected, '100000.00');
    assert.equal(driftFull.actual, '150000.00');
    assert.equal(driftFull.difference, '50000.00');
    assert.equal(driftFull.mode, 'FULL');
  } finally {
    // Dọn dẹp ví test
    await prisma.anomalyAdjustment.deleteMany({ where: { walletId: wallet.id } });
    await prisma.reconciliationAnomaly.deleteMany({ where: { walletId: wallet.id } });
    await prisma.wallet.delete({ where: { id: wallet.id } }).catch(() => {});
    server.close();
  }
});

test('K17-1: Ví có số dư âm (fixture) -> Phát hiện NEGATIVE_BALANCE với thông tin chính xác', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const testUserId = randomUUID();
  let walletId: number | null = null;

  try {
    // Tạm thời drop constraint check trong DB test để tạo fixture ví âm
    await prisma.$executeRawUnsafe('ALTER TABLE "Wallet" DROP CONSTRAINT IF EXISTS "wallet_balance_check";');
    await prisma.$executeRawUnsafe('ALTER TABLE "Wallet" DROP CONSTRAINT IF EXISTS "wallet_held_balance_check";');

    const wallet = await prisma.wallet.create({
      data: {
        userId: testUserId,
        balance: -25000,
        heldBalance: 0,
        currency: 'VND',
        ownerType: OwnerType.USER,
        kycTier: 1,
      },
    });
    walletId = wallet.id;

    const res = await fetch(`${baseUrl}/api/wallets/admin/reconciliation`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(res.status, 200);
    const json = await res.json();

    const negAnomaly = json.data.anomalies.find((a: any) => a.walletId === wallet.id && a.type === 'NEGATIVE_BALANCE');
    assert.ok(negAnomaly, 'Phải phát hiện bất thường NEGATIVE_BALANCE');
    assert.equal(negAnomaly.walletId, wallet.id);
    assert.equal(negAnomaly.actual, '-25000.00');
    assert.equal(negAnomaly.expected, '0.00');
    assert.equal(negAnomaly.difference, '-25000.00');
    assert.equal(negAnomaly.status, 'OPEN');
  } finally {
    if (walletId) {
      await prisma.reconciliationAnomaly.deleteMany({ where: { walletId } });
      await prisma.wallet.delete({ where: { id: walletId } }).catch(() => {});
    }
    // Khôi phục lại constraint check của DB
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Wallet" ADD CONSTRAINT "wallet_balance_check" CHECK ("ownerType" = \'SYSTEM\' OR "balance" >= 0) NOT VALID;'
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Wallet" ADD CONSTRAINT "wallet_held_balance_check" CHECK ("ownerType" = \'SYSTEM\' OR "heldBalance" <= "balance") NOT VALID;'
    ).catch(() => {});
    await prisma.$executeRawUnsafe('ALTER TABLE "Wallet" VALIDATE CONSTRAINT "wallet_balance_check";').catch(() => {});
    await prisma.$executeRawUnsafe('ALTER TABLE "Wallet" VALIDATE CONSTRAINT "wallet_held_balance_check";').catch(() => {});
    server.close();
  }
});

test('K17-1: Chạy đối soát là CHỈ ĐỌC trên dữ liệu tiền - không sửa đổi bất kỳ số dư ví hay LedgerEntry nào', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const canaryUserId = randomUUID();
  const canaryWallet = await prisma.wallet.create({
    data: {
      userId: canaryUserId,
      balance: 150000,
      heldBalance: 20000,
      currency: 'VND',
      ownerType: OwnerType.USER,
      kycTier: 1,
    },
  });

  try {
    // Snapshot ví canary và các ví hiện có
    const walletsBefore = await prisma.wallet.findMany({
      where: { id: canaryWallet.id },
      select: { id: true, balance: true, heldBalance: true },
    });

    // Chạy đối soát liên tiếp 3 lần cả quick và full
    await fetch(`${baseUrl}/api/wallets/admin/reconciliation?mode=quick`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    await fetch(`${baseUrl}/api/wallets/admin/reconciliation?mode=full`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    await fetch(`${baseUrl}/reconciliation`, {
      headers: { 'x-gateway-token': adminToken() },
    });

    // So sánh sau khi chạy
    const canaryAfter = await prisma.wallet.findUnique({
      where: { id: canaryWallet.id },
      select: { id: true, balance: true, heldBalance: true },
    });
    const canaryLedgers = await prisma.ledgerEntry.findMany({
      where: { walletId: canaryWallet.id },
    });

    assert.ok(canaryAfter);
    assert.equal(canaryAfter.balance.toFixed(2), '150000.00', 'Số dư ví canary không được đổi');
    assert.equal(canaryAfter.heldBalance.toFixed(2), '20000.00', 'Số dư tạm giữ ví canary không được đổi');
    assert.equal(canaryLedgers.length, 0, 'Chạy đối soát tuyệt đối không được sinh bất kỳ LedgerEntry nào');
  } finally {
    await prisma.reconciliationAnomaly.deleteMany({ where: { walletId: canaryWallet.id } });
    await prisma.wallet.delete({ where: { id: canaryWallet.id } }).catch(() => {});
    server.close();
  }
});
