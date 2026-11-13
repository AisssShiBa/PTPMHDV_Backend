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

test('K14-5: Nghiệm thu 1 - 3 instance releaseExpiredHolds chạy song song trên N hold hết hạn', async () => {
  await seedLimitPolicies();
  
  // Tạo 3 ví người dùng, mỗi ví có 3 hold hết hạn (tổng N = 9 holds)
  const users = await Promise.all([
    createTestWallet(500000),
    createTestWallet(500000),
    createTestWallet(500000),
  ]);

  const holdRefs: string[] = [];
  const holdAmount = 20000;
  const futureExpiry = new Date(Date.now() + 60000).toISOString();

  for (const user of users) {
    for (let i = 0; i < 3; i++) {
      const ref = `k14_conc_${randomUUID()}`;
      holdRefs.push(ref);
      await holdService.createHold(user.userId, holdAmount.toString(), ref, futureExpiry);
    }
  }

  // Cập nhật expiresAt lùi về quá khứ để giả lập hết hạn
  await prisma.walletHold.updateMany({
    where: { referenceId: { in: holdRefs } },
    data: { expiresAt: new Date(Date.now() - 30000) },
  });

  // Xác nhận 9 hold đều ở trạng thái PENDING và đã hết hạn
  const createdHolds = await prisma.walletHold.findMany({
    where: { referenceId: { in: holdRefs } },
  });
  assert.strictEqual(createdHolds.length, 9, 'Tất cả 9 hold đã được tạo');
  for (const h of createdHolds) {
    assert.strictEqual(h.status, HoldStatus.PENDING);
    assert.ok(h.expiresAt <= new Date());
  }

  for (const user of users) {
    const w = await prisma.wallet.findUnique({ where: { id: user.wallet.id } });
    assert.strictEqual(Number(w?.heldBalance), holdAmount * 3, 'heldBalance tăng đúng 60,000');
    const usage = await prisma.userDailyUsage.findUnique({
      where: { userId_day: { userId: user.userId, day: getVnDay() } },
    });
    assert.strictEqual(Number(usage?.spentDay), holdAmount * 3, 'spentDay tăng đúng 60,000');
  }

  // Chạy 3 instance releaseExpiredHolds đồng thời
  const [res1, res2, res3] = await Promise.all([
    holdService.releaseExpiredHolds({ instanceId: 'inst-conc-1', batchSize: 20 }),
    holdService.releaseExpiredHolds({ instanceId: 'inst-conc-2', batchSize: 20 }),
    holdService.releaseExpiredHolds({ instanceId: 'inst-conc-3', batchSize: 20 }),
  ]);

  const totalReleased = res1.released + res2.released + res3.released;
  assert.ok(totalReleased >= 9, `Tổng số hold nhả (${totalReleased}) phải >= 9`);

  // Kiểm tra từng hold trong 9 hold: mỗi hold nhả đúng 1 lần và sang EXPIRED
  const holdsAfter = await prisma.walletHold.findMany({
    where: { referenceId: { in: holdRefs } },
  });
  for (const h of holdsAfter) {
    assert.strictEqual(h.status, HoldStatus.EXPIRED, `Hold ${h.referenceId} phải có trạng thái EXPIRED`);
  }

  // Kiểm tra số dư và hạn mức của 3 người dùng: hoàn đúng 1 lần, không âm
  for (const user of users) {
    const wAfter = await prisma.wallet.findUnique({ where: { id: user.wallet.id } });
    assert.strictEqual(Number(wAfter?.heldBalance), 0, `heldBalance của user ${user.userId} phải về 0`);
    assert.strictEqual(Number(wAfter?.balance), 500000, `balance của user ${user.userId} giữ nguyên 500,000`);

    const usageAfter = await prisma.userDailyUsage.findUnique({
      where: { userId_day: { userId: user.userId, day: getVnDay() } },
    });
    assert.strictEqual(Number(usageAfter?.spentDay), 0, `spentDay của user ${user.userId} hoàn đúng 1 lần về 0`);
  }

  // Dọn dẹp dữ liệu test
  await prisma.walletHold.deleteMany({ where: { referenceId: { in: holdRefs } } });
});

test('K14-5: Nghiệm thu 2a - Sweeper đua với captureHold trên cùng một hold', async () => {
  await seedLimitPolicies();
  const user = await createTestWallet(300000);
  const ref = `race_cap_${randomUUID()}`;
  const futureExpiry = new Date(Date.now() + 60000).toISOString();

  await holdService.createHold(user.userId, '50000', ref, futureExpiry);
  await prisma.walletHold.updateMany({
    where: { referenceId: ref },
    data: { expiresAt: new Date(Date.now() - 5000) },
  });

  const initialLedgerCount = await prisma.ledgerEntry.count({ where: { walletId: user.wallet.id } });

  // Kích hoạt song song sweeper và captureHold
  const [sweepRes, captureRes] = await Promise.allSettled([
    holdService.releaseExpiredHolds({ instanceId: 'race-cap-sweeper', walletId: user.wallet.id }),
    holdService.captureHold(user.userId, ref),
  ]);

  // Đúng 1 bên thắng:
  // Nếu sweeper thắng: sweepRes thành công với released=1, captureRes reject với HOLD_EXPIRED (409)
  // Nếu capture thắng: captureRes thành công, sweepRes trả released=0 (bỏ qua vì hold đã CAPTURED)
  const holdFinal = await prisma.walletHold.findFirstOrThrow({ where: { referenceId: ref } });
  
  if (holdFinal.status === HoldStatus.EXPIRED) {
    // Sweeper thắng
    assert.strictEqual(sweepRes.status, 'fulfilled');
    assert.strictEqual(captureRes.status, 'rejected');
    const err = (captureRes as PromiseRejectedResult).reason;
    assert.ok(err instanceof DomainException && err.code === 'HOLD_EXPIRED', 'captureHold ném HOLD_EXPIRED');

    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: user.wallet.id } });
    assert.strictEqual(Number(wallet.heldBalance), 0);
    assert.strictEqual(Number(wallet.balance), 300000);

    const ledgerCountAfter = await prisma.ledgerEntry.count({ where: { walletId: user.wallet.id } });
    assert.strictEqual(ledgerCountAfter, initialLedgerCount, 'Không sinh bút toán thừa khi sweeper thắng');
  } else {
    // Capture thắng
    assert.strictEqual(holdFinal.status, HoldStatus.CAPTURED);
    assert.strictEqual(captureRes.status, 'fulfilled');
    
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: user.wallet.id } });
    assert.strictEqual(Number(wallet.heldBalance), 0);
    assert.strictEqual(Number(wallet.balance), 250000);

    const ledgerCountAfter = await prisma.ledgerEntry.count({ where: { walletId: user.wallet.id } });
    assert.strictEqual(ledgerCountAfter, initialLedgerCount + 1, 'Sinh đúng 1 bút toán ledger khi capture thắng');
  }

  // Đảm bảo không có trường nào bị âm
  const walletCheck = await prisma.wallet.findUniqueOrThrow({ where: { id: user.wallet.id } });
  assert.ok(Number(walletCheck.heldBalance) >= 0);
  assert.ok(Number(walletCheck.balance) >= 0);

  const usageCheck = await prisma.userDailyUsage.findUnique({
    where: { userId_day: { userId: user.userId, day: getVnDay() } },
  });
  assert.ok(Number(usageCheck?.spentDay ?? 0) >= 0);

  await prisma.walletHold.deleteMany({ where: { referenceId: ref } });
});

test('K14-5: Nghiệm thu 2b - Sweeper đua với releaseHold trên cùng một hold', async () => {
  await seedLimitPolicies();
  const user = await createTestWallet(300000);
  const ref = `race_rel_${randomUUID()}`;
  const futureExpiry = new Date(Date.now() + 60000).toISOString();

  await holdService.createHold(user.userId, '70000', ref, futureExpiry);
  await prisma.walletHold.updateMany({
    where: { referenceId: ref },
    data: { expiresAt: new Date(Date.now() - 5000) },
  });

  const initialLedgerCount = await prisma.ledgerEntry.count({ where: { walletId: user.wallet.id } });

  // Kích hoạt song song sweeper và releaseHold
  const [sweepRes, releaseRes] = await Promise.allSettled([
    holdService.releaseExpiredHolds({ instanceId: 'race-rel-sweeper', walletId: user.wallet.id }),
    holdService.releaseHold(user.userId, ref),
  ]);

  // Cả 2 đều phải thành công nhờ tính lũy đẳng (một bên nhả thực tế, một bên replayed)
  assert.strictEqual(sweepRes.status, 'fulfilled', 'Sweeper hoàn thành thành công');
  assert.strictEqual(releaseRes.status, 'fulfilled', 'releaseHold hoàn thành thành công');

  const holdFinal = await prisma.walletHold.findFirstOrThrow({ where: { referenceId: ref } });
  assert.ok(
    holdFinal.status === HoldStatus.EXPIRED || holdFinal.status === HoldStatus.RELEASED,
    'Hold kết thúc ở EXPIRED hoặc RELEASED'
  );

  // Số dư và hạn mức chỉ được trừ/hoàn đúng 1 lần (không bị nhân đôi hay âm)
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: user.wallet.id } });
  assert.strictEqual(Number(wallet.heldBalance), 0, 'heldBalance về 0');
  assert.strictEqual(Number(wallet.balance), 300000, 'balance giữ nguyên 300,000');

  const usage = await prisma.userDailyUsage.findUnique({
    where: { userId_day: { userId: user.userId, day: getVnDay() } },
  });
  assert.strictEqual(Number(usage?.spentDay), 0, 'Hạn mức hoàn về 0, không bị âm');

  const ledgerCountAfter = await prisma.ledgerEntry.count({ where: { walletId: user.wallet.id } });
  assert.strictEqual(ledgerCountAfter, initialLedgerCount, 'Không sinh bút toán ledger khi hết hạn/release');

  await prisma.walletHold.deleteMany({ where: { referenceId: ref } });
});
