const paymentDbUrl = process.env.PAYMENT_DATABASE_URL || 'postgresql://postgres:8932ce4c6b28dba8c13430d3317b1e51e4f8838c6b02824423f9b57b69d56d4a@localhost:5432/payment_service?schema=public';
const walletDbUrl = process.env.WALLET_DATABASE_URL || 'postgresql://postgres:8932ce4c6b28dba8c13430d3317b1e51e4f8838c6b02824423f9b57b69d56d4a@localhost:5432/wallet_service?schema=public';

process.env.PAYMENT_DATABASE_URL = paymentDbUrl;
process.env.DATABASE_URL = walletDbUrl;
process.env.RABBITMQ_URL = '';

import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import http from 'node:http';
import { randomUUID } from 'crypto';
import { PrismaClient as PaymentPrisma, PaymentStatus } from '@prisma/client';
import { PrismaClient as WalletPrisma, OwnerType, HoldStatus } from '../../wallet-service/node_modules/@prisma/client';
import walletApp from '../../wallet-service/src/app';
import { WalletHoldService } from '../../wallet-service/src/services/wallet-hold.service';
import { LedgerService } from '../../wallet-service/src/services/ledger.service';
import { LimitService } from '../../wallet-service/src/services/limit.service';
import { seedLimitPolicies } from '../../wallet-service/prisma/seed';
import { getVnDay } from '../../wallet-service/src/utils/timezone.helper';
import { P2pService } from '../src/services/p2p.service';
import { WalletClient } from '../src/clients/wallet.client';
import { sweepExpiredPayments } from '../src/jobs/payment-expiry.job';
import { DomainException } from '../src/utils/domain.exception';

// Import hàm kiểm tra bất biến từ script K14
const { getSnapshot, compareSnapshots } = require('../../../scripts/check-k14-invariants.cjs');

const pPrisma = new PaymentPrisma({ datasources: { db: { url: paymentDbUrl } } });
const wPrisma = new WalletPrisma({ datasources: { db: { url: walletDbUrl } } });

const ledgerService = new LedgerService();
const limitService = new LimitService();
const holdService = new WalletHoldService(ledgerService, limitService);

let walletServer: http.Server;
let walletClient: WalletClient;
let p2pService: P2pService;

before(async () => {
  await seedLimitPolicies();
  walletServer = http.createServer(walletApp);
  await new Promise<void>((resolve) => walletServer.listen(0, resolve));
  const port = (walletServer.address() as any).port;
  process.env.WALLET_SERVICE_URL = `http://127.0.0.1:${port}`;
  process.env.INTERNAL_KEY = 'f6f2f278e1bddbc7d16c19851cc828ce455015504709b35d232383543d6c1e68';

  walletClient = new WalletClient();
  p2pService = new P2pService(walletClient);
});

after(async () => {
  walletServer.close();
  await pPrisma.$disconnect();
  await wPrisma.$disconnect();
});

async function createWallet(balance: number, kycTier = 2) {
  const userId = randomUUID();
  const wallet = await wPrisma.wallet.create({
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

test('K14-5: Nghiệm thu 3 - E2E P2P checkout quá 5 phút -> sweeper + payment job -> EXPIRED, hoàn hạn mức, confirm bị từ chối, bảo toàn số dư', async () => {
  // 1. Chụp snapshot trạng thái hệ thống trước test
  const snapshotBefore = await getSnapshot(wPrisma);

  const initialLedgerCount = await wPrisma.ledgerEntry.count();

  // 2. Tạo 2 người dùng P2P: User A (500k) và User B (100k)
  const userA = await createWallet(500000);
  const userB = await createWallet(100000);

  // 3. Thực hiện checkout P2P chuyển 150,000 VND
  const checkoutAmount = 150000;
  const idempotencyKey = `idem_e2e_${randomUUID()}`;

  const checkoutResult = await p2pService.checkout({
    userId: userA.userId,
    destinationUserId: userB.userId,
    amount: checkoutAmount.toString(),
    type: 'WALLET_TRANSFER',
    idempotencyKey,
  });

  const paymentId = checkoutResult.payment.id;
  const holdId = checkoutResult.payment.holdId!;
  assert.strictEqual(checkoutResult.payment.status, PaymentStatus.PENDING);
  assert.strictEqual(checkoutResult.payment.workflow, 'IDLE');

  // Kiểm tra trạng thái ví sau checkout: heldBalance = 150,000, spentDay = 150,000
  const walletAAfterCheckout = await wPrisma.wallet.findUniqueOrThrow({ where: { id: userA.wallet.id } });
  assert.strictEqual(Number(walletAAfterCheckout.heldBalance), checkoutAmount, 'heldBalance tăng đúng 150k');
  assert.strictEqual(Number(walletAAfterCheckout.balance), 500000, 'balance người gửi không đổi');

  const usageAfterCheckout = await wPrisma.userDailyUsage.findUnique({
    where: { userId_day: { userId: userA.userId, day: getVnDay() } },
  });
  assert.strictEqual(Number(usageAfterCheckout?.spentDay), checkoutAmount, 'spentDay tăng đúng 150k');

  // Chuẩn bị token xác thực giao dịch
  const tokenPayload = {
    sub: userA.userId,
    paymentId,
    amount: checkoutResult.payment.amount,
    jti: randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60,
  };

  // 4. Giả lập quá 5 phút (lùi expiresAt của WalletHold và holdExpiresAt của Payment về 6 phút trước)
  const pastTime = new Date(Date.now() - 360000); // 6 phút trước
  await wPrisma.walletHold.updateMany({
    where: { referenceId: holdId },
    data: { expiresAt: pastTime },
  });
  await pPrisma.payment.update({
    where: { id: paymentId },
    data: { holdExpiresAt: pastTime },
  });

  // 5. Kích hoạt sweeper giải phóng hold hết hạn ở wallet-service
  const walletSweepResult = await holdService.releaseExpiredHolds({
    instanceId: 'e2e-wallet-sweeper',
    walletId: userA.wallet.id,
  });
  assert.strictEqual(walletSweepResult.released, 1, 'Wallet sweeper nhả đúng 1 hold');

  // Kiểm tra WalletHold -> EXPIRED, heldBalance về 0, spentDay hoàn về 0
  const holdAfterSweep = await wPrisma.walletHold.findFirstOrThrow({ where: { referenceId: holdId } });
  assert.strictEqual(holdAfterSweep.status, HoldStatus.EXPIRED, 'Hold chuyển EXPIRED');

  const walletAAfterSweep = await wPrisma.wallet.findUniqueOrThrow({ where: { id: userA.wallet.id } });
  assert.strictEqual(Number(walletAAfterSweep.heldBalance), 0, 'heldBalance đã hoàn về 0');
  assert.strictEqual(Number(walletAAfterSweep.balance), 500000, 'balance người gửi vẫn nguyên 500k');

  const usageAfterSweep = await wPrisma.userDailyUsage.findUnique({
    where: { userId_day: { userId: userA.userId, day: getVnDay() } },
  });
  assert.strictEqual(Number(usageAfterSweep?.spentDay), 0, 'spentDay đã được hoàn về 0');

  // 6. Kích hoạt payment-expiry job ở payment-service
  const paymentSweepResult = await sweepExpiredPayments({
    prismaClient: pPrisma as any,
    walletClient,
    paymentId,
  });
  assert.strictEqual(paymentSweepResult.expired, 1, 'Payment sweeper chuyển đúng 1 payment sang EXPIRED');

  const paymentAfterSweep = await pPrisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  assert.strictEqual(paymentAfterSweep.status, PaymentStatus.EXPIRED, 'Payment chuyển EXPIRED');

  // Kiểm tra outbox event payment.expired được phát ra
  const outboxEvents = await pPrisma.outboxEvent.findMany({
    where: { aggregateId: paymentId, eventType: 'payment.expired' },
  });
  assert.strictEqual(outboxEvents.length, 1, 'Đúng 1 outbox event payment.expired được ghi');

  // 7. Thử xác nhận giao dịch (confirm) với transaction token cũ -> BỊ TỪ CHỐI
  await assert.rejects(
    async () => {
      await p2pService.confirm(paymentId, userA.userId, tokenPayload as any);
    },
    (err: any) => {
      assert.ok(err instanceof DomainException, 'Phải ném DomainException');
      assert.strictEqual(err.status, 409, 'Status 409 Conflict');
      assert.strictEqual(err.code, 'PAYMENT_NOT_CONFIRMABLE', 'Mã lỗi PAYMENT_NOT_CONFIRMABLE');
      return true;
    },
    'Xác nhận confirm với payment đã EXPIRED phải bị từ chối'
  );

  // 8. KIỂM TRA BẤT BIẾN HỆ THỐNG:
  // - Số dư User A = 500,000; User B = 100,000
  // - LedgerEntry không tăng thêm (hết hạn không sinh bút toán)
  const ledgerCountA = await wPrisma.ledgerEntry.count({ where: { walletId: userA.wallet.id } });
  const ledgerCountB = await wPrisma.ledgerEntry.count({ where: { walletId: userB.wallet.id } });
  assert.strictEqual(ledgerCountA, 0, 'User A không có bút toán ledger (Delta = 0)');
  assert.strictEqual(ledgerCountB, 0, 'User B không có bút toán ledger (Delta = 0)');

  const walletAFinal = await wPrisma.wallet.findUniqueOrThrow({ where: { id: userA.wallet.id } });
  const walletBFinal = await wPrisma.wallet.findUniqueOrThrow({ where: { id: userB.wallet.id } });
  assert.strictEqual(Number(walletAFinal.balance), 500000, 'User A balance bảo toàn 500k');
  assert.strictEqual(Number(walletAFinal.heldBalance), 0, 'User A heldBalance về 0');
  assert.strictEqual(Number(walletBFinal.balance), 100000, 'User B balance bảo toàn 100k');
  assert.strictEqual(Number(walletBFinal.heldBalance), 0, 'User B heldBalance về 0');

  // Dọn dẹp hold
  await wPrisma.walletHold.deleteMany({ where: { referenceId: holdId } });
});
