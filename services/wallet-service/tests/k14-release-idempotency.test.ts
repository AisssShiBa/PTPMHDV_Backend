import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient, OwnerType, HoldStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { LedgerService } from '../src/services/ledger.service';
import { WalletHoldService } from '../src/services/wallet-hold.service';
import { LimitService } from '../src/services/limit.service';
import { seedLimitPolicies } from '../prisma/seed';
import { getVnDay } from '../src/utils/timezone.helper';
import { DomainException } from '../src/utils/domain.exception';

const prisma = new PrismaClient();
const ledgerService = new LedgerService();
const limitService = new LimitService();
const holdService = new WalletHoldService(ledgerService, limitService);

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

test('K14-3: release sau sweeper trả thành công lũy đẳng, không hoàn hạn mức lần 2', async () => {
  await seedLimitPolicies();
  const user = await createTestWallet(500000);
  const ref = randomUUID();
  const future = new Date(Date.now() + 60000).toISOString();

  await holdService.createHold(user.userId, '100000', ref, future);

  // Ép hết hạn và cho sweeper nhả trước
  await prisma.walletHold.updateMany({
    where: { referenceId: ref },
    data: { expiresAt: new Date(Date.now() - 5000) },
  });
  
  const holdCheck = await prisma.walletHold.findFirst({ where: { referenceId: ref } });
  if (holdCheck?.status === HoldStatus.PENDING) {
    await holdService.releaseExpiredHolds({ instanceId: 'k14-3-swp-first' });
  }

  const holdExpired = await prisma.walletHold.findFirst({ where: { referenceId: ref } });
  assert.strictEqual(holdExpired?.status, HoldStatus.EXPIRED, 'Hold đã được sweeper chuyển sang EXPIRED');

  const usageAfterSweep = await prisma.userDailyUsage.findUnique({
    where: { userId_day: { userId: user.userId, day: getVnDay() } },
  });
  assert.strictEqual(Number(usageAfterSweep?.spentDay), 0, 'Hạn mức đã hoàn về 0 sau sweeper');

  // Gọi releaseHold sau khi sweeper đã nhả
  const releaseRes = await holdService.releaseHold(user.userId, ref);
  assert.strictEqual(releaseRes.replayed, true, 'replayed phải là true');
  assert.strictEqual(releaseRes.hold.status, HoldStatus.EXPIRED, 'Giữ nguyên trạng thái EXPIRED');

  // Kiểm tra số dư và hạn mức không bị hoàn đúp
  const wallet = await prisma.wallet.findUnique({
    where: { userId_ownerType: { userId: user.userId, ownerType: OwnerType.USER } },
  });
  assert.strictEqual(Number(wallet?.heldBalance), 0, 'heldBalance không đổi');
  assert.strictEqual(Number(wallet?.balance), 500000, 'balance không đổi');

  const usageFinal = await prisma.userDailyUsage.findUnique({
    where: { userId_day: { userId: user.userId, day: getVnDay() } },
  });
  assert.strictEqual(Number(usageFinal?.spentDay), 0, 'Hạn mức không bị hoàn lần hai (không âm)');

  await prisma.walletHold.deleteMany({ where: { referenceId: ref } });
});

test('K14-3: release hai lần liên tiếp trả kết quả lũy đẳng', async () => {
  await seedLimitPolicies();
  const user = await createTestWallet(500000);
  const ref = randomUUID();
  const future = new Date(Date.now() + 60000).toISOString();

  await holdService.createHold(user.userId, '100000', ref, future);

  // Lần 1: release thành công
  const res1 = await holdService.releaseHold(user.userId, ref);
  assert.strictEqual(res1.replayed, false);
  assert.strictEqual(res1.hold.status, HoldStatus.RELEASED);

  // Lần 2: release lần nữa
  const res2 = await holdService.releaseHold(user.userId, ref);
  assert.strictEqual(res2.replayed, true);
  assert.strictEqual(res2.hold.status, HoldStatus.RELEASED);

  const wallet = await prisma.wallet.findUnique({
    where: { userId_ownerType: { userId: user.userId, ownerType: OwnerType.USER } },
  });
  assert.strictEqual(Number(wallet?.heldBalance), 0);

  const usage = await prisma.userDailyUsage.findUnique({
    where: { userId_day: { userId: user.userId, day: getVnDay() } },
  });
  assert.strictEqual(Number(usage?.spentDay), 0);

  await prisma.walletHold.deleteMany({ where: { referenceId: ref } });
});

test('K14-3: sweeper chạy sau khi hold đã RELEASED không đụng đến hold', async () => {
  await seedLimitPolicies();
  const user = await createTestWallet(500000);
  const ref = randomUUID();
  const future = new Date(Date.now() + 60000).toISOString();

  await holdService.createHold(user.userId, '100000', ref, future);
  await holdService.releaseHold(user.userId, ref);

  // Làm cho hold này qua hạn
  await prisma.walletHold.updateMany({
    where: { referenceId: ref },
    data: { expiresAt: new Date(Date.now() - 5000) },
  });

  const sweepRes = await holdService.releaseExpiredHolds({ instanceId: 'k14-3-after-rel', walletId: user.wallet.id });
  const hold = await prisma.walletHold.findFirst({ where: { referenceId: ref } });

  assert.strictEqual(hold?.status, HoldStatus.RELEASED, 'Hold vẫn giữ nguyên RELEASED');

  const usage = await prisma.userDailyUsage.findUnique({
    where: { userId_day: { userId: user.userId, day: getVnDay() } },
  });
  assert.strictEqual(Number(usage?.spentDay), 0, 'Hạn mức không bị trừ tiếp');

  await prisma.walletHold.deleteMany({ where: { referenceId: ref } });
});

test('K14-3: capture sau khi sweeper đã nhả trả lỗi HOLD_EXPIRED (không regress)', async () => {
  await seedLimitPolicies();
  const user = await createTestWallet(500000);
  const ref = randomUUID();
  const future = new Date(Date.now() + 60000).toISOString();

  await holdService.createHold(user.userId, '100000', ref, future);

  // Cho sweeper nhả
  await prisma.walletHold.updateMany({
    where: { referenceId: ref },
    data: { expiresAt: new Date(Date.now() - 5000) },
  });
  await holdService.releaseExpiredHolds({ instanceId: 'k14-3-cap-swp', walletId: user.wallet.id });

  // Gọi captureHold -> phải ném conflict HOLD_EXPIRED
  let caughtError: any = null;
  try {
    await holdService.captureHold(user.userId, ref);
  } catch (err) {
    caughtError = err;
  }

  assert.ok(caughtError, 'captureHold phải ném lỗi');
  assert.strictEqual(caughtError.code, 'HOLD_EXPIRED', 'Mã lỗi phải là HOLD_EXPIRED');

  const wallet = await prisma.wallet.findUnique({
    where: { userId_ownerType: { userId: user.userId, ownerType: OwnerType.USER } },
  });
  assert.strictEqual(Number(wallet?.balance), 500000, 'balance không đổi');
  assert.strictEqual(Number(wallet?.heldBalance), 0, 'heldBalance không đổi');

  await prisma.walletHold.deleteMany({ where: { referenceId: ref } });
});

test('K14-3: Hạn mức không bị hoàn đôi trong mọi thứ tự (Đua giữa releaseHold và sweeper)', async () => {
  await seedLimitPolicies();
  const user = await createTestWallet(500000);
  const ref = randomUUID();
  const future = new Date(Date.now() + 60000).toISOString();

  await holdService.createHold(user.userId, '150000', ref, future);

  // Set hết hạn
  await prisma.walletHold.updateMany({
    where: { referenceId: ref },
    data: { expiresAt: new Date(Date.now() - 5000) },
  });

  // Gọi đồng thời releaseHold VÀ 2 sweeper
  await Promise.allSettled([
    holdService.releaseHold(user.userId, ref),
    holdService.releaseExpiredHolds({ instanceId: 'k14-3-race-1', walletId: user.wallet.id }),
    holdService.releaseExpiredHolds({ instanceId: 'k14-3-race-2', walletId: user.wallet.id }),
  ]);

  const usage = await prisma.userDailyUsage.findUnique({
    where: { userId_day: { userId: user.userId, day: getVnDay() } },
  });
  assert.strictEqual(Number(usage?.spentDay), 0, 'Hạn mức hoàn đúng 150k về 0, không âm');

  const wallet = await prisma.wallet.findUnique({
    where: { userId_ownerType: { userId: user.userId, ownerType: OwnerType.USER } },
  });
  assert.strictEqual(Number(wallet?.heldBalance), 0);
  assert.strictEqual(Number(wallet?.balance), 500000);

  await prisma.walletHold.deleteMany({ where: { referenceId: ref } });
});
