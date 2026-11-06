const paymentDbUrl = process.env.PAYMENT_DATABASE_URL || 'postgresql://postgres:8932ce4c6b28dba8c13430d3317b1e51e4f8838c6b02824423f9b57b69d56d4a@localhost:5432/payment_service?schema=public';
const walletDbUrl = process.env.WALLET_DATABASE_URL || 'postgresql://postgres:8932ce4c6b28dba8c13430d3317b1e51e4f8838c6b02824423f9b57b69d56d4a@localhost:5432/wallet_service?schema=public';

process.env.PAYMENT_DATABASE_URL = paymentDbUrl;
process.env.DATABASE_URL = walletDbUrl;
process.env.RABBITMQ_URL = '';

import assert from 'node:assert/strict';
import { test, before, after, describe } from 'node:test';
import http from 'node:http';
import { randomUUID } from 'crypto';
import { PrismaClient as PaymentPrisma, PaymentType, PaymentStatus, IdempotencyStatus, Prisma } from '@prisma/client';
import { PrismaClient as WalletPrisma, OwnerType, HoldStatus } from '../../wallet-service/node_modules/@prisma/client';
import walletApp from '../../wallet-service/src/app';
import { seedLimitPolicies } from '../../wallet-service/prisma/seed';
import { LedgerService } from '../../wallet-service/src/services/ledger.service';
import { P2pService } from '../src/services/p2p.service';
import { WalletClient } from '../src/clients/wallet.client';
import { prisma as paymentPrismaClient } from '../src/utils/prisma';
import path from 'path';

const { getFinancialSnapshot, verifyDeltaConservation } = require(path.resolve(__dirname, '../../../scripts/check-k16-invariants.cjs'));

const pPrisma = new PaymentPrisma({ datasources: { db: { url: paymentDbUrl } } });
const wPrisma = new WalletPrisma({ datasources: { db: { url: walletDbUrl } } });
const ledgerService = new LedgerService();

let walletServer: http.Server;
let walletClient: WalletClient;
let p2pService: P2pService;

class SlowWalletClient extends WalletClient {
  public delayMs: number = 2000;
  public createHoldCalls: number = 0;
  public captureHoldCalls: number = 0;

  override async createHold(
    userId: string,
    amount: string,
    referenceId: string,
    expiresAt: string,
    destinationUserId?: string,
    destinationOwnerType?: string
  ) {
    this.createHoldCalls++;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return super.createHold(userId, amount, referenceId, expiresAt, destinationUserId, destinationOwnerType);
  }

  override async captureHold(userId: string, referenceId: string) {
    this.captureHoldCalls++;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return super.captureHold(userId, referenceId);
  }
}

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
      ownerType: OwnerType.USER,
      balance,
      heldBalance: 0,
      currency: 'VND',
      status: 'ACTIVE',
      kycTier,
    },
  });
  return { userId, walletId: wallet.id, wallet };
}

describe('K16-5: Specialized Crash, Slow-Wallet, and Financial Invariant Suite', () => {

  // --------------------------------------------------------------------------
  // 1. CRASH TEST & RECOVERY AT PHASE BOUNDARIES (completeHold & resume)
  // --------------------------------------------------------------------------
  test('Crash Boundary 1: completeHold crash sau Pha 1 (trước Pha 2 gọi ví) -> recover hoàn tất thành công, đúng 1 hold', async () => {
    const sender = await createWallet(100000);
    const receiver = await createWallet(50000);
    const paymentId = randomUUID();
    const holdId = randomUUID();
    const idempotencyKey = `crash-c1-${Date.now()}`;

    // Giả lập: Tiến trình chết ngay sau Pha 1 claim HOLD_CALLING. Lease đã hết hạn.
    await pPrisma.payment.create({
      data: {
        id: paymentId,
        referenceId: `ref-${paymentId}`,
        callbackTopic: 'finvault.events',
        requestHash: `hash-${paymentId}`,
        idempotencyExpiresAt: new Date(Date.now() + 86400000),
        userId: sender.userId,
        type: PaymentType.WALLET_TRANSFER,
        amount: new Prisma.Decimal(30000),
        status: PaymentStatus.PENDING,
        idempotencyKey,
        idempotencyStatus: IdempotencyStatus.PENDING,
        workflow: 'HOLD_CALLING',
        workerLeaseUntil: new Date(Date.now() - 5000), // Lease expired
        attempt: 1,
        holdId,
        destinationUserId: receiver.userId,
        destinationOwnerType: 'USER',
        holdExpiresAt: new Date(Date.now() + 300000),
      },
    });

    const beforeSnap = await getFinancialSnapshot(wPrisma);

    // Chạy lại qua recovery worker
    await p2pService.recover();

    const afterSnap = await getFinancialSnapshot(wPrisma);
    verifyDeltaConservation(beforeSnap, afterSnap);

    // Kiểm tra payment state
    const payment = await pPrisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    assert.strictEqual(payment.workflow, 'IDLE', 'Workflow phải về IDLE sau khi recover hoàn tất');
    assert.strictEqual(payment.idempotencyStatus, IdempotencyStatus.COMPLETED, 'IdempotencyStatus phải là COMPLETED');

    // Kiểm tra ví: đúng 1 hold được tạo
    const holds = await wPrisma.walletHold.findMany({ where: { referenceId: holdId } });
    assert.strictEqual(holds.length, 1, 'Ví phải có đúng 1 hold');
    assert.strictEqual(holds[0].status, HoldStatus.PENDING);
    assert.strictEqual(Number(holds[0].amount), 30000);
  });

  test('Crash Boundary 2: completeHold crash sau Pha 2 (ví đã tạo hold nhưng chết trước Pha 3 chốt DB) -> recover lũy đẳng, không tạo hold kép', async () => {
    const sender = await createWallet(100000);
    const receiver = await createWallet(50000);
    const paymentId = randomUUID();
    const holdId = randomUUID();
    const idempotencyKey = `crash-c2-${Date.now()}`;

    // Tạo hold ở ví trước (mô phỏng Pha 2 đã gọi thành công sang ví)
    await walletClient.createHold(
      sender.userId,
      '40000',
      holdId,
      new Date(Date.now() + 300000).toISOString(),
      receiver.userId,
      'USER'
    );

    // Trong DB payment-service, payment vẫn ở HOLD_CALLING (chết trước Pha 3)
    await pPrisma.payment.create({
      data: {
        id: paymentId,
        referenceId: `ref-${paymentId}`,
        callbackTopic: 'finvault.events',
        requestHash: `hash-${paymentId}`,
        idempotencyExpiresAt: new Date(Date.now() + 86400000),
        userId: sender.userId,
        type: PaymentType.WALLET_TRANSFER,
        amount: new Prisma.Decimal(40000),
        status: PaymentStatus.PENDING,
        idempotencyKey,
        idempotencyStatus: IdempotencyStatus.PENDING,
        workflow: 'HOLD_CALLING',
        workerLeaseUntil: new Date(Date.now() - 5000), // Lease expired
        attempt: 1,
        holdId,
        destinationUserId: receiver.userId,
        destinationOwnerType: 'USER',
        holdExpiresAt: new Date(Date.now() + 300000),
      },
    });

    const beforeSnap = await getFinancialSnapshot(wPrisma);

    // Chạy lại qua recover()
    await p2pService.recover();

    const afterSnap = await getFinancialSnapshot(wPrisma);
    verifyDeltaConservation(beforeSnap, afterSnap);

    const payment = await pPrisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    assert.strictEqual(payment.workflow, 'IDLE');
    assert.strictEqual(payment.idempotencyStatus, IdempotencyStatus.COMPLETED);

    // Kiểm tra ví: vẫn đúng 1 hold duy nhất, không nhân đôi
    const holds = await wPrisma.walletHold.findMany({ where: { referenceId: holdId } });
    assert.strictEqual(holds.length, 1, 'Ví không được có hold trùng lặp');
  });

  test('Crash Boundary 3: resume crash sau Pha 1 (trước Pha 2 gọi capture ví) -> recover gọi capture thành công, chốt SUCCESS', async () => {
    const sender = await createWallet(100000);
    const receiver = await createWallet(50000);
    const paymentId = randomUUID();
    const holdId = randomUUID();

    // Tạo hold hợp lệ ở ví
    await walletClient.createHold(
      sender.userId,
      '25000',
      holdId,
      new Date(Date.now() + 300000).toISOString(),
      receiver.userId,
      'USER'
    );

    // Giả lập chết sau Pha 1 của resume: workflow CAPTURE_CALLING, status PENDING, chưa gọi capture
    await pPrisma.payment.create({
      data: {
        id: paymentId,
        referenceId: `ref-${paymentId}`,
        callbackTopic: 'finvault.events',
        requestHash: `hash-${paymentId}`,
        idempotencyExpiresAt: new Date(Date.now() + 86400000),
        userId: sender.userId,
        type: PaymentType.WALLET_TRANSFER,
        amount: new Prisma.Decimal(25000),
        status: PaymentStatus.PENDING,
        idempotencyKey: `crash-r1-${Date.now()}`,
        idempotencyStatus: IdempotencyStatus.COMPLETED,
        workflow: 'CAPTURE_CALLING',
        workerLeaseUntil: new Date(Date.now() - 5000), // Lease expired
        attempt: 1,
        holdId,
        destinationUserId: receiver.userId,
        destinationOwnerType: 'USER',
        holdExpiresAt: new Date(Date.now() + 300000),
      },
    });

    const beforeSnap = await getFinancialSnapshot(wPrisma);

    // Chạy lại qua recover
    await p2pService.recover();

    const afterSnap = await getFinancialSnapshot(wPrisma);
    verifyDeltaConservation(beforeSnap, afterSnap);

    const payment = await pPrisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    assert.strictEqual(payment.status, PaymentStatus.SUCCESS);
    assert.strictEqual(payment.workflow, 'IDLE');

    // Kiểm tra ví: hold đã chuyển CAPTURED
    const hold = await wPrisma.walletHold.findFirstOrThrow({ where: { referenceId: holdId } });
    assert.strictEqual(hold.status, HoldStatus.CAPTURED);

    // Số dư người nhận tăng 25.000, người gửi giảm 25.000
    const wReceiver = await wPrisma.wallet.findUniqueOrThrow({ where: { id: receiver.walletId } });
    assert.strictEqual(Number(wReceiver.balance), 75000);
  });

  test('Crash Boundary 4: resume crash sau Pha 2 (ví đã capture, chết trước Pha 3 chốt DB) -> recover phát hiện lookup COMPLETED, chốt SUCCESS không trừ lần 2', async () => {
    const sender = await createWallet(100000);
    const receiver = await createWallet(50000);
    const paymentId = randomUUID();
    const holdId = randomUUID();

    // Tạo và capture ở ví trực tiếp
    await walletClient.createHold(
      sender.userId,
      '35000',
      holdId,
      new Date(Date.now() + 300000).toISOString(),
      receiver.userId,
      'USER'
    );
    await walletClient.captureHold(sender.userId, holdId);

    // Trong DB payment-service, payment vẫn ở PENDING & CAPTURE_CALLING
    await pPrisma.payment.create({
      data: {
        id: paymentId,
        referenceId: `ref-${paymentId}`,
        callbackTopic: 'finvault.events',
        requestHash: `hash-${paymentId}`,
        idempotencyExpiresAt: new Date(Date.now() + 86400000),
        userId: sender.userId,
        type: PaymentType.WALLET_TRANSFER,
        amount: new Prisma.Decimal(35000),
        status: PaymentStatus.PENDING,
        idempotencyKey: `crash-r2-${Date.now()}`,
        idempotencyStatus: IdempotencyStatus.COMPLETED,
        workflow: 'CAPTURE_CALLING',
        workerLeaseUntil: new Date(Date.now() - 5000), // Lease expired
        attempt: 1,
        holdId,
        destinationUserId: receiver.userId,
        destinationOwnerType: 'USER',
        holdExpiresAt: new Date(Date.now() + 300000),
      },
    });

    const beforeSnap = await getFinancialSnapshot(wPrisma);

    // Chạy lại qua recover()
    await p2pService.recover();

    const afterSnap = await getFinancialSnapshot(wPrisma);
    verifyDeltaConservation(beforeSnap, afterSnap);

    const payment = await pPrisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    assert.strictEqual(payment.status, PaymentStatus.SUCCESS);
    assert.strictEqual(payment.workflow, 'IDLE');

    // Kiểm tra số bút toán của hold: đúng 1 credit và 1 debit (không trừ kép!)
    const entries = await wPrisma.ledgerEntry.findMany({ where: { referenceId: holdId } });
    assert.strictEqual(entries.length, 2, 'Phải có đúng 2 bút toán (1 DEBIT sender, 1 CREDIT receiver)');

    const wSender = await wPrisma.wallet.findUniqueOrThrow({ where: { id: sender.walletId } });
    const wReceiver = await wPrisma.wallet.findUniqueOrThrow({ where: { id: receiver.walletId } });
    assert.strictEqual(Number(wSender.balance), 65000);
    assert.strictEqual(Number(wReceiver.balance), 85000);
  });

  // --------------------------------------------------------------------------
  // 2. MOCK VÍ CHẬM: DB TRANSACTION DURATION < 100ms & KHÔNG KHÓA HÀNG
  // --------------------------------------------------------------------------
  test('Mock ví chậm (2s): Thời gian giữ DB transaction < 100ms, không kéo dài theo HTTP', async () => {
    const slowWallet = new SlowWalletClient();
    slowWallet.delayMs = 2000;
    const slowP2pService = new P2pService(slowWallet);

    const sender = await createWallet(100000);
    const receiver = await createWallet(50000);
    const idempotencyKey = `slow-tx-${Date.now()}`;

    // Đặt bộ đo thời gian giữ transaction của payment Prisma
    const txDurations: number[] = [];
    const originalTransaction = paymentPrismaClient.$transaction.bind(paymentPrismaClient);

    (paymentPrismaClient as any).$transaction = async function (fnOrArray: any, options: any) {
      const start = Date.now();
      try {
        return await originalTransaction(fnOrArray, options);
      } finally {
        txDurations.push(Date.now() - start);
      }
    };

    try {
      const overallStart = Date.now();

      // 1. Checkout (completeHold có gọi ví createHold trễ 2s)
      const checkoutRes = await slowP2pService.checkout({
        userId: sender.userId,
        destinationUserId: receiver.userId,
        amount: '20000',
        type: 'WALLET_TRANSFER',
        idempotencyKey,
      });

      const overallCheckoutDuration = Date.now() - overallStart;
      assert.ok(overallCheckoutDuration >= 1900, `Tổng thời gian checkout phải >= 2s do ví chậm (thực tế: ${overallCheckoutDuration}ms)`);

      // Kiểm tra tất cả các $transaction trong completeHold
      console.log('DB Transaction durations during completeHold:', txDurations);
      for (const dur of txDurations) {
        assert.ok(dur < 150, `Thời gian DB transaction phải < 150ms (thực tế: ${dur}ms), không được kéo dài theo HTTP`);
      }

      // 2. Confirm (resume có gọi ví captureHold trễ 2s)
      const resumeStartTxCount = txDurations.length;
      const confirmStart = Date.now();

      const confirmRes = await slowP2pService.confirm(
        checkoutRes.payment.id,
        sender.userId,
        {
          sub: sender.userId,
          paymentId: checkoutRes.payment.id,
          amount: new Prisma.Decimal(20000),
          jti: randomUUID(),
        }
      );

      const overallConfirmDuration = Date.now() - confirmStart;
      assert.ok(overallConfirmDuration >= 1900, `Tổng thời gian confirm phải >= 2s do ví chậm (thực tế: ${overallConfirmDuration}ms)`);
      assert.strictEqual(confirmRes.status, 'SUCCESS');

      const resumeTxDurations = txDurations.slice(resumeStartTxCount);
      console.log('DB Transaction durations during resume:', resumeTxDurations);
      for (const dur of resumeTxDurations) {
        assert.ok(dur < 150, `Thời gian DB transaction trong resume phải < 150ms (thực tế: ${dur}ms)`);
      }
    } finally {
      (paymentPrismaClient as any).$transaction = originalTransaction;
    }
  });

  test('Mock ví chậm: Request đồng thời không bị nghẽn connection pool và không bị khóa hàng', async () => {
    const slowWallet = new SlowWalletClient();
    slowWallet.delayMs = 2000;
    const slowP2pService = new P2pService(slowWallet);

    const userA = await createWallet(100000);
    const userB = await createWallet(50000);
    const userC = await createWallet(100000);
    const userD = await createWallet(50000);

    const keyA = `slow-concurrent-a-${Date.now()}`;
    const keyC = `fast-concurrent-c-${Date.now()}`;

    // Request 1: User A checkout qua slow wallet (chậm 2 giây)
    const req1Promise = slowP2pService.checkout({
      userId: userA.userId,
      destinationUserId: userB.userId,
      amount: '15000',
      type: 'WALLET_TRANSFER',
      idempotencyKey: keyA,
    });

    // Đợi 200ms để Request 1 chắc chắn đã qua Phase 1 DB transaction và đang nằm ở Phase 2 (gọi HTTP ví)
    await new Promise((r) => setTimeout(r, 200));

    // Request 2: User C checkout bằng standard wallet (nhanh bình thường)
    // Chứng minh: Connection pool của DB không bị Request 1 chiếm giữ, không bị nghẽn!
    const req2Start = Date.now();
    const req2Res = await p2pService.checkout({
      userId: userC.userId,
      destinationUserId: userD.userId,
      amount: '20000',
      type: 'WALLET_TRANSFER',
      idempotencyKey: keyC,
    });
    const req2Duration = Date.now() - req2Start;

    // Request 2 hoàn tất rất nhanh (< 300ms) trong khi Request 1 vẫn đang chờ ví chậm
    assert.ok(req2Duration < 300, `Request 2 phải hoàn tất nhanh (< 300ms), không bị nghẽn connection pool (thực tế: ${req2Duration}ms)`);
    assert.strictEqual(req2Res.payment.workflow, 'IDLE');

    // Chờ Request 1 hoàn tất
    const req1Res = await req1Promise;
    assert.strictEqual(req1Res.payment.workflow, 'IDLE');

    // A2 Replayed Check: Gửi lại keyA sau khi hoàn tất -> trả ngay replayed: true trong < 50ms
    const a2ReplayStart = Date.now();
    const a2Res = await slowP2pService.checkout({
      userId: userA.userId,
      destinationUserId: userB.userId,
      amount: '15000',
      type: 'WALLET_TRANSFER',
      idempotencyKey: keyA,
    });
    const a2Duration = Date.now() - a2ReplayStart;

    assert.ok(a2Duration < 500, `A2 replayed checkout phải phản hồi tức thì (< 500ms) (thực tế: ${a2Duration}ms)`);
    assert.strictEqual(a2Res.replayed, true, 'Lần gọi lại phải trả replayed: true');
    assert.strictEqual(a2Res.payment.id, req1Res.payment.id, 'Phải cùng paymentId');
  });

  // --------------------------------------------------------------------------
  // 3. TÁI KIỂM CHỨNG MỐC A1 VÀ A2 (Khớp với mốc baseline K16-1)
  // --------------------------------------------------------------------------
  test('Tái kiểm chứng Mốc A1: 20 request song song 60k trên ví 100k -> 1 SUCCESS, 19 FAILED, còn 40k', async () => {
    const { userId: senderId, wallet: senderWallet } = await createWallet(100000);
    const { userId: receiverId } = await createWallet(0);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        ledgerService.transfer({
          fromUserId: senderId,
          toUserId: receiverId,
          amount: '60000',
          referenceId: `k16-5-a1-${i}-${randomUUID()}`,
          transferType: 'P2P_TRANSFER' as any,
          note: `A1 recheck transfer ${i}`
        })
      )
    );

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'Đúng 1 request phải thành công');
    assert.equal(rejected.length, 19, '19 request phải bị từ chối');

    const updatedSender = await wPrisma.wallet.findUniqueOrThrow({ where: { id: senderWallet.id } });
    assert.equal(Number(updatedSender.balance), 40000, 'Số dư người gửi phải còn đúng 40.000đ');
  });

  test('Tái kiểm chứng Mốc A2: Gửi checkout 2 lần cùng Idempotency-Key -> 1 payment, lần 2 replayed: true', async () => {
    const { userId: senderId } = await createWallet(200000);
    const dest = await createWallet(0);
    const idempotencyKey = `k16-5-a2-key-${randomUUID()}`;

    const res1 = await p2pService.checkout({
      userId: senderId,
      destinationUserId: dest.userId,
      amount: '50000',
      type: 'WALLET_TRANSFER',
      idempotencyKey,
    });

    assert.equal(res1.replayed, false, 'Lần 1 phải replayed: false');
    assert.ok(res1.payment.id);

    const res2 = await p2pService.checkout({
      userId: senderId,
      destinationUserId: dest.userId,
      amount: '50000',
      type: 'WALLET_TRANSFER',
      idempotencyKey,
    });

    assert.equal(res2.replayed, true, 'Lần 2 phải replayed: true');
    assert.equal(res2.payment.id, res1.payment.id, 'Phải trả về cùng 1 paymentId');

    const paymentCount = await pPrisma.payment.count({
      where: { userId: senderId, idempotencyKey }
    });
    assert.equal(paymentCount, 1, 'Chỉ có đúng 1 payment được tạo trong cơ sở dữ liệu');
  });

});
