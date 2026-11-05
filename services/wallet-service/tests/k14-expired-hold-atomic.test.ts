import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient, OwnerType, HoldStatus, TransferType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { LedgerService } from '../src/services/ledger.service';
import { WalletHoldService } from '../src/services/wallet-hold.service';
import { LimitService } from '../src/services/limit.service';
import { seedLimitPolicies } from '../prisma/seed';
import { getVnDay, getVnMonthKey } from '../src/utils/timezone.helper';

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

test('K14-2: Ví một hold hết hạn -> heldBalance về 0, balance gốc không đổi', async () => {
  await seedLimitPolicies();
  const user = await createTestWallet(500000);
  const ref = randomUUID();
  const future = new Date(Date.now() + 60000).toISOString();

  await holdService.createHold(user.userId, '120000', ref, future);

  // Ép hết hạn
  await prisma.walletHold.updateMany({
    where: { referenceId: ref },
    data: { expiresAt: new Date(Date.now() - 5000) },
  });

  const res = await holdService.releaseExpiredHolds({ instanceId: 'k14-2-single' });
  assert.strictEqual(res.released >= 1, true);

  const wallet = await prisma.wallet.findUnique({
    where: { userId_ownerType: { userId: user.userId, ownerType: OwnerType.USER } },
  });
  assert.strictEqual(Number(wallet?.balance), 500000, 'Số dư gốc không đổi');
  assert.strictEqual(Number(wallet?.heldBalance), 0, 'heldBalance về đúng 0');

  const hold = await prisma.walletHold.findFirst({ where: { referenceId: ref } });
  assert.strictEqual(hold?.status, HoldStatus.EXPIRED);
});

test('K14-2: Ví hai hold -> chỉ trừ đúng phần hold hết hạn, không về 0 cưỡng ép', async () => {
  await seedLimitPolicies();
  const user = await createTestWallet(500000);
  const refExp = randomUUID();
  const refActive = randomUUID();
  const future = new Date(Date.now() + 3600000).toISOString();

  await holdService.createHold(user.userId, '100000', refExp, future);
  await holdService.createHold(user.userId, '150000', refActive, future);

  // Chỉ làm hết hạn refExp
  await prisma.walletHold.updateMany({
    where: { referenceId: refExp },
    data: { expiresAt: new Date(Date.now() - 5000) },
  });

  const walletBefore = await prisma.wallet.findUnique({
    where: { userId_ownerType: { userId: user.userId, ownerType: OwnerType.USER } },
  });
  assert.strictEqual(Number(walletBefore?.heldBalance), 250000);

  const res = await holdService.releaseExpiredHolds({ instanceId: 'k14-2-dual' });
  assert.strictEqual(res.released >= 1, true);

  const walletAfter = await prisma.wallet.findUnique({
    where: { userId_ownerType: { userId: user.userId, ownerType: OwnerType.USER } },
  });
  assert.strictEqual(Number(walletAfter?.heldBalance), 150000, 'heldBalance chỉ bị trừ đúng 100k, còn 150k của hold chưa hết hạn');

  const holdExp = await prisma.walletHold.findFirst({ where: { referenceId: refExp } });
  assert.strictEqual(holdExp?.status, HoldStatus.EXPIRED);

  const holdActive = await prisma.walletHold.findFirst({ where: { referenceId: refActive } });
  assert.strictEqual(holdActive?.status, HoldStatus.PENDING);
});

test('K14-2: Hoàn hạn mức đúng ngày khi hold tạo trước nửa đêm UTC+7 và hết hạn sau nửa đêm', async () => {
  await seedLimitPolicies();
  const user = await createTestWallet(500000);
  const ref = randomUUID();

  // Giả lập hold tạo ngày hôm qua theo UTC+7
  const yesterdayDay = '2026-10-20';
  const yesterdayMonthKey = '2026-10';
  const holdAmount = 150000;

  // Tạo UserDailyUsage ngày hôm qua với spentDay = 150000
  await prisma.userDailyUsage.create({
    data: {
      userId: user.userId,
      day: yesterdayDay,
      monthKey: yesterdayMonthKey,
      spentDay: holdAmount,
    },
  });

  // Tạo ví với heldBalance = 150000
  await prisma.wallet.update({
    where: { userId_ownerType: { userId: user.userId, ownerType: OwnerType.USER } },
    data: { heldBalance: holdAmount },
  });

  // Tạo WalletHold có usageDay = '2026-10-20', expiresAt trong quá khứ
  await prisma.walletHold.create({
    data: {
      sourceWalletId: user.wallet.id,
      amount: holdAmount,
      referenceId: ref,
      status: HoldStatus.PENDING,
      expiresAt: new Date(Date.now() - 10000),
      usageDay: yesterdayDay,
    },
  });

  const res = await holdService.releaseExpiredHolds({ instanceId: 'k14-2-midnight' });
  assert.strictEqual(res.released >= 1, true);

  // Kiểm tra spentDay của ngày hôm qua đã được trừ về 0
  const yesterdayUsage = await prisma.userDailyUsage.findUnique({
    where: { userId_day: { userId: user.userId, day: yesterdayDay } },
  });
  assert.strictEqual(Number(yesterdayUsage?.spentDay), 0, 'Hạn mức ngày tạo hold (hôm qua) được hoàn về 0');

  // Kiểm tra ngày hôm nay không bị tạo hoặc thay đổi sai
  const todayDay = getVnDay();
  const todayUsage = await prisma.userDailyUsage.findUnique({
    where: { userId_day: { userId: user.userId, day: todayDay } },
  });
  if (todayUsage) {
    assert.strictEqual(Number(todayUsage.spentDay), 0);
  }
});

test('K14-2: Hold đã CAPTURED hoặc RELEASED không bị đụng', async () => {
  await seedLimitPolicies();
  const user = await createTestWallet(500000);
  const refCap = randomUUID();
  const refRel = randomUUID();

  // Tạo hold CAPTURED và RELEASED đã qua expiresAt
  const past = new Date(Date.now() - 10000);
  await prisma.walletHold.createMany({
    data: [
      {
        sourceWalletId: user.wallet.id,
        amount: 50000,
        referenceId: refCap,
        status: HoldStatus.CAPTURED,
        expiresAt: past,
        usageDay: getVnDay(),
        transactionId: randomUUID(),
      },
      {
        sourceWalletId: user.wallet.id,
        amount: 60000,
        referenceId: refRel,
        status: HoldStatus.RELEASED,
        expiresAt: past,
        usageDay: getVnDay(),
      },
    ],
  });

  await holdService.releaseExpiredHolds({ instanceId: 'k14-2-already-final' });

  const holdCap = await prisma.walletHold.findFirst({ where: { referenceId: refCap } });
  const holdRel = await prisma.walletHold.findFirst({ where: { referenceId: refRel } });

  assert.strictEqual(holdCap?.status, HoldStatus.CAPTURED);
  assert.strictEqual(holdRel?.status, HoldStatus.RELEASED);
});

test('K14-2: LedgerEntry không đổi - hết hạn không sinh bút toán', async () => {
  await seedLimitPolicies();
  const user = await createTestWallet(500000);
  const ref = randomUUID();
  const future = new Date(Date.now() + 60000).toISOString();

  await holdService.createHold(user.userId, '80000', ref, future);
  await prisma.walletHold.updateMany({
    where: { referenceId: ref },
    data: { expiresAt: new Date(Date.now() - 5000) },
  });

  const ledgerCountBefore = await prisma.ledgerEntry.count({
    where: { walletId: user.wallet.id },
  });

  await holdService.releaseExpiredHolds({ instanceId: 'k14-2-no-ledger' });

  const ledgerCountAfter = await prisma.ledgerEntry.count({
    where: { walletId: user.wallet.id },
  });
  assert.strictEqual(ledgerCountBefore, 0, 'Lúc tạo hold không sinh bút toán');
  assert.strictEqual(ledgerCountAfter, 0, 'Khi hold hết hạn tuyệt đối không sinh bút toán');

  await prisma.walletHold.deleteMany({ where: { referenceId: ref } });
});

test('K14-2: Lỗi giữa chừng rollback cả ba thay đổi (nguyên tử)', async () => {
  await seedLimitPolicies();
  const user = await createTestWallet(500000);
  const ref = randomUUID();
  const day = getVnDay();
  const holdAmount = 100000;

  // Tạo hold và usage hợp lệ lúc ban đầu
  const future = new Date(Date.now() + 60000).toISOString();
  await holdService.createHold(user.userId, '100000', ref, future);
  await prisma.walletHold.updateMany({
    where: { referenceId: ref },
    data: { expiresAt: new Date(Date.now() - 5000) },
  });

  // Phá hoại spentDay xuống 50.000 để khi hoàn 100.000 sẽ bị âm -> throw NEGATIVE_SPENT_DAY
  await prisma.userDailyUsage.update({
    where: { userId_day: { userId: user.userId, day } },
    data: { spentDay: 50000 },
  });

  const res = await holdService.releaseExpiredHolds({ instanceId: 'k14-2-atomic-rollback' });
  assert.strictEqual(res.errors >= 1, true);

  // Kiểm tra cả 3 thay đổi đều bị rollback:
  // 1. WalletHold vẫn PENDING
  const hold = await prisma.walletHold.findFirst({ where: { referenceId: ref } });
  assert.strictEqual(hold?.status, HoldStatus.PENDING, 'Hold không được đổi sang EXPIRED');

  // 2. Wallet heldBalance vẫn 100000
  const wallet = await prisma.wallet.findUnique({
    where: { userId_ownerType: { userId: user.userId, ownerType: OwnerType.USER } },
  });
  assert.strictEqual(Number(wallet?.heldBalance), 100000, 'heldBalance không bị trừ');

  // 3. UserDailyUsage vẫn 50000
  const usage = await prisma.userDailyUsage.findUnique({
    where: { userId_day: { userId: user.userId, day } },
  });
  assert.strictEqual(Number(usage?.spentDay), 50000, 'spentDay không bị trừ');

  await prisma.walletHold.deleteMany({ where: { referenceId: ref } });
});
