import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient, OwnerType, HoldStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { LedgerService } from '../src/services/ledger.service';
import { WalletHoldService } from '../src/services/wallet-hold.service';
import { LimitService } from '../src/services/limit.service';
import { seedLimitPolicies } from '../prisma/seed';
import { getVnDay } from '../src/utils/timezone.helper';

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

test('K14-1: Lượt không có hold hết hạn', async () => {
  await seedLimitPolicies();
  // Dọn dẹp bất kỳ hold PENDING đã hết hạn cũ từ các test khác
  await prisma.walletHold.updateMany({
    where: { status: HoldStatus.PENDING, expiresAt: { lte: new Date() } },
    data: { status: HoldStatus.EXPIRED },
  });

  const result = await holdService.releaseExpiredHolds({ instanceId: 'test-inst-empty' });
  assert.strictEqual(result.scanned, 0);
  assert.strictEqual(result.released, 0);
  assert.strictEqual(result.skipped, 0);
  assert.strictEqual(result.errors, 0);
  assert.strictEqual(result.instanceId, 'test-inst-empty');
  assert.strictEqual(typeof result.durationMs, 'number');
});

test('K14-1: Nhiều hold hết hạn đều được nhả sạch', async () => {
  await seedLimitPolicies();
  const user1 = await createTestWallet(500000);
  const user2 = await createTestWallet(500000);
  const user3 = await createTestWallet(500000);

  const ref1 = randomUUID();
  const ref2 = randomUUID();
  const ref3 = randomUUID();
  const future = new Date(Date.now() + 60000).toISOString();

  await holdService.createHold(user1.userId, '100000', ref1, future);
  await holdService.createHold(user2.userId, '150000', ref2, future);
  await holdService.createHold(user3.userId, '200000', ref3, future);

  // Ép hết hạn cả 3 hold
  const past = new Date(Date.now() - 10000);
  await prisma.walletHold.updateMany({
    where: { referenceId: { in: [ref1, ref2, ref3] } },
    data: { expiresAt: past },
  });

  const result = await holdService.releaseExpiredHolds({ instanceId: 'test-inst-multi' });
  assert.strictEqual(result.released >= 3, true);

  // Kiểm tra trạng thái 3 hold
  const holds = await prisma.walletHold.findMany({
    where: { referenceId: { in: [ref1, ref2, ref3] } },
  });
  for (const h of holds) {
    assert.strictEqual(h.status, HoldStatus.EXPIRED);
  }

  // Kiểm tra heldBalance của 3 ví đã về 0
  const w1 = await prisma.wallet.findUnique({ where: { userId_ownerType: { userId: user1.userId, ownerType: OwnerType.USER } } });
  const w2 = await prisma.wallet.findUnique({ where: { userId_ownerType: { userId: user2.userId, ownerType: OwnerType.USER } } });
  const w3 = await prisma.wallet.findUnique({ where: { userId_ownerType: { userId: user3.userId, ownerType: OwnerType.USER } } });
  assert.strictEqual(Number(w1?.heldBalance), 0);
  assert.strictEqual(Number(w2?.heldBalance), 0);
  assert.strictEqual(Number(w3?.heldBalance), 0);
});

test('K14-1: Hold chưa hết hạn không bị đụng', async () => {
  await seedLimitPolicies();
  const user = await createTestWallet(500000);
  const ref = randomUUID();
  const future = new Date(Date.now() + 3600000).toISOString(); // 1 giờ sau

  await holdService.createHold(user.userId, '100000', ref, future);

  const beforeHold = await prisma.walletHold.findFirst({
    where: { referenceId: ref },
  });
  assert.strictEqual(beforeHold?.status, HoldStatus.PENDING);

  await holdService.releaseExpiredHolds({ instanceId: 'test-inst-future' });

  const afterHold = await prisma.walletHold.findFirst({
    where: { referenceId: ref },
  });
  assert.strictEqual(afterHold?.status, HoldStatus.PENDING);

  const wallet = await prisma.wallet.findUnique({
    where: { userId_ownerType: { userId: user.userId, ownerType: OwnerType.USER } },
  });
  assert.strictEqual(Number(wallet?.heldBalance), 100000);
});

test('K14-1: Hold lỗi không chặn hold khác (lỗi được log và đi tiếp hold khác)', async () => {
  await seedLimitPolicies();
  const userFail = await createTestWallet(500000);
  const userOk = await createTestWallet(500000);

  const refFail = randomUUID();
  const refOk = randomUUID();
  const future = new Date(Date.now() + 60000).toISOString();

  await holdService.createHold(userFail.userId, '100000', refFail, future);
  await holdService.createHold(userOk.userId, '100000', refOk, future);

  const past = new Date(Date.now() - 10000);
  await prisma.walletHold.updateMany({
    where: { referenceId: { in: [refFail, refOk] } },
    data: { expiresAt: past },
  });

  // Cố tình làm sai lệch heldBalance của userFail thành 0 -> khiến trừ heldBalance sẽ âm -> ném lỗi và rollback
  await prisma.wallet.update({
    where: { userId_ownerType: { userId: userFail.userId, ownerType: OwnerType.USER } },
    data: { heldBalance: 0 },
  });

  const result = await holdService.releaseExpiredHolds({ instanceId: 'test-inst-err-isolate' });
  assert.strictEqual(result.errors >= 1, true, 'Có ít nhất 1 hold bị lỗi');
  assert.strictEqual(result.released >= 1, true, 'Hold hợp lệ vẫn được nhả thành công');

  // refOk phải được chuyển sang EXPIRED
  const holdOk = await prisma.walletHold.findFirst({ where: { referenceId: refOk } });
  assert.strictEqual(holdOk?.status, HoldStatus.EXPIRED);

  // refFail bị rollback nên vẫn PENDING
  const holdFail = await prisma.walletHold.findFirst({ where: { referenceId: refFail } });
  assert.strictEqual(holdFail?.status, HoldStatus.PENDING);

  // Dọn dẹp hold lỗi để không ảnh hưởng test khác
  await prisma.walletHold.deleteMany({ where: { referenceId: { in: [refFail, refOk] } } });
});

test('K14-1: Cuối mỗi lượt log đúng cấu trúc và số liệu', async () => {
  await seedLimitPolicies();
  const user = await createTestWallet(500000);
  const ref = randomUUID();
  const past = new Date(Date.now() - 5000);

  // Tạo hold trực tiếp đã hết hạn
  await prisma.wallet.update({
    where: { userId_ownerType: { userId: user.userId, ownerType: OwnerType.USER } },
    data: { heldBalance: 50000 },
  });
  await prisma.walletHold.create({
    data: {
      sourceWalletId: user.wallet.id,
      amount: 50000,
      referenceId: ref,
      expiresAt: past,
      status: HoldStatus.PENDING,
      usageDay: getVnDay(),
    },
  });

  // Spy console.log
  const originalLog = console.log;
  const loggedLines: string[] = [];
  console.log = (...args: any[]) => {
    loggedLines.push(args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
    originalLog(...args);
  };

  const testInstanceId = 'k14-log-test-' + randomUUID().slice(0, 8);
  let result;
  try {
    result = await holdService.releaseExpiredHolds({ instanceId: testInstanceId });
  } finally {
    console.log = originalLog;
  }

  // Tìm dòng log có chứa testInstanceId
  const matchLine = loggedLines.find(line => line.includes(testInstanceId));
  assert.ok(matchLine, 'Phải có một dòng log chứa instanceId');

  const parsed = JSON.parse(matchLine);
  assert.strictEqual(parsed.instanceId, testInstanceId);
  assert.strictEqual(parsed.scanned, result.scanned);
  assert.strictEqual(parsed.released, result.released);
  assert.strictEqual(parsed.skipped, result.skipped);
  assert.strictEqual(parsed.errors, result.errors);
  assert.strictEqual(parsed.durationMs, result.durationMs);

  await prisma.walletHold.deleteMany({ where: { referenceId: ref } });
});
