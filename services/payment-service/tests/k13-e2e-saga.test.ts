const paymentDbUrl = process.env.PAYMENT_DATABASE_URL || 'postgresql://postgres:8932ce4c6b28dba8c13430d3317b1e51e4f8838c6b02824423f9b57b69d56d4a@localhost:5432/payment_service?schema=public';
const walletDbUrl = process.env.WALLET_DATABASE_URL || 'postgresql://postgres:8932ce4c6b28dba8c13430d3317b1e51e4f8838c6b02824423f9b57b69d56d4a@localhost:5432/wallet_service?schema=public';

process.env.PAYMENT_DATABASE_URL = paymentDbUrl;
process.env.DATABASE_URL = walletDbUrl;
process.env.RABBITMQ_URL = '';

import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import http from 'node:http';
import { randomUUID } from 'crypto';
import { PrismaClient as PaymentPrisma, PaymentStatus, PaymentType, OutboxEventStatus } from '@prisma/client';
import { PrismaClient as WalletPrisma, OwnerType, SystemWalletCode } from '../../wallet-service/node_modules/@prisma/client';
import walletApp from '../../wallet-service/src/app';
import { WalletHoldService } from '../../wallet-service/src/services/wallet-hold.service';
import { LedgerService } from '../../wallet-service/src/services/ledger.service';
import { seedLimitPolicies } from '../../wallet-service/prisma/seed';
import { PaymentService } from '../src/services/payment.service';
import { drainRefundOutbox, claimRefundOutboxEvents, processRefundEvent } from '../src/jobs/refund.worker';
import { WalletClient } from '../src/clients/wallet.client';

const pPrisma = new PaymentPrisma({ datasources: { db: { url: paymentDbUrl } } });
const wPrisma = new WalletPrisma({ datasources: { db: { url: walletDbUrl } } });

const ledgerService = new LedgerService();
const holdService = new WalletHoldService(ledgerService);

let walletServer: http.Server;
let walletClient: WalletClient;
let paymentService: PaymentService;

before(async () => {
  await seedLimitPolicies();
  walletServer = http.createServer(walletApp);
  await new Promise<void>((resolve) => walletServer.listen(0, resolve));
  const port = (walletServer.address() as any).port;
  process.env.WALLET_SERVICE_URL = `http://127.0.0.1:${port}`;
  process.env.INTERNAL_KEY = 'f6f2f278e1bddbc7d16c19851cc828ce455015504709b35d232383543d6c1e68';

  walletClient = new WalletClient();
  paymentService = new PaymentService(walletClient);
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

async function createPayment(params: {
  userId: string;
  destinationUserId?: string;
  amount: number;
  holdId: string;
  type?: PaymentType;
}) {
  const id = randomUUID();
  const payment = await pPrisma.payment.create({
    data: {
      id,
      userId: params.userId,
      destinationUserId: params.destinationUserId ?? null,
      amount: params.amount,
      type: params.type || (params.destinationUserId ? PaymentType.WALLET_TRANSFER : PaymentType.BUS_TICKET),
      status: PaymentStatus.SUCCESS,
      holdId: params.holdId,
      referenceId: `ref_${randomUUID()}`,
      requestHash: `hash_${randomUUID()}`,
      idempotencyKey: `idem_${randomUUID()}`,
      idempotencyExpiresAt: new Date(Date.now() + 86400000),
      callbackTopic: 'payment.order_paid',
    },
  });
  return payment;
}

test('K13-11: Luồng E2E thành công P2P và non-P2P, bảo toàn số dư toàn hệ thống', async () => {
  const userA = await createWallet(500000);
  const userB = await createWallet(100000);
  const userC = await createWallet(300000);

  const refCaptureP2P = `p2p_hold_${randomUUID()}`;
  const expiry = new Date(Date.now() + 60000).toISOString();

  // User A chuyển 150,000 VND sang User B
  await holdService.createHold(userA.userId, '150000', refCaptureP2P, expiry, OwnerType.USER, userB.userId);
  await holdService.captureHold(userA.userId, refCaptureP2P);

  // Tạo Payment P2P ở payment-service
  const paymentP2P = await createPayment({
    userId: userA.userId,
    destinationUserId: userB.userId,
    amount: 150000,
    holdId: refCaptureP2P,
  });

  // User C thanh toán 80,000 VND vé xe bus (destination mặc định là SETTLEMENT)
  const refCaptureNonP2P = `bus_hold_${randomUUID()}`;
  const settlementBefore = await wPrisma.wallet.findUniqueOrThrow({
    where: { systemCode: SystemWalletCode.SETTLEMENT },
  });
  await holdService.createHold(userC.userId, '80000', refCaptureNonP2P, expiry, OwnerType.USER);
  await holdService.captureHold(userC.userId, refCaptureNonP2P);

  const paymentNonP2P = await createPayment({
    userId: userC.userId,
    amount: 80000,
    holdId: refCaptureNonP2P,
    type: PaymentType.BUS_TICKET,
  });

  // --- NGHIỆM THU 3: TỔNG TOÀN HỆ THỐNG TRƯỚC KHI HOÀN TIỀN ---
  const totalBefore = (await wPrisma.wallet.aggregate({ _sum: { balance: true } }))._sum.balance;

  // Bắt đầu Saga hoàn tiền P2P
  const refundInitP2P = await paymentService.refund(paymentP2P.id, 'admin_k13', 'ADMIN');
  assert.equal(refundInitP2P.status, PaymentStatus.REFUNDING);

  // Bắt đầu Saga hoàn tiền Non-P2P
  const refundInitNonP2P = await paymentService.refund(paymentNonP2P.id, 'admin_k13', 'ADMIN');
  assert.equal(refundInitNonP2P.status, PaymentStatus.REFUNDING);

  // Worker chạy drain
  await drainRefundOutbox({ prismaClient: pPrisma as any, walletClient });

  // Kiểm tra Payment P2P đã chuyển sang REFUNDED
  const paymentP2PAfter = await pPrisma.payment.findUniqueOrThrow({ where: { id: paymentP2P.id } });
  assert.equal(paymentP2PAfter.status, PaymentStatus.REFUNDED);
  assert.ok(paymentP2PAfter.refundedAt);

  // Kiểm tra Outbox payment.refunded
  const p2pRefundedEvents = await pPrisma.outboxEvent.findMany({
    where: { aggregateId: paymentP2P.id, eventType: 'payment.refunded' },
  });
  assert.equal(p2pRefundedEvents.length, 1);

  // Kiểm tra số dư ví P2P được đảo ngược ĐÚNG ĐỐI ỨNG (User B -> User A)
  const wAAfterRefund = await wPrisma.wallet.findUniqueOrThrow({ where: { id: userA.wallet.id } });
  const wBAfterRefund = await wPrisma.wallet.findUniqueOrThrow({ where: { id: userB.wallet.id } });
  assert.equal(Number(wAAfterRefund.balance), 500000, 'Ví người gửi được hoàn đủ tiền về ban đầu');
  assert.equal(Number(wBAfterRefund.balance), 100000, 'Ví người nhận bị trừ tiền hoàn về ban đầu');

  // Kiểm tra Payment non-P2P đã chuyển sang REFUNDED
  const paymentNonP2PAfter = await pPrisma.payment.findUniqueOrThrow({ where: { id: paymentNonP2P.id } });
  assert.equal(paymentNonP2PAfter.status, PaymentStatus.REFUNDED);

  // Kiểm tra số dư ví non-P2P
  const wCAfterRefund = await wPrisma.wallet.findUniqueOrThrow({ where: { id: userC.wallet.id } });
  const settlementAfter = await wPrisma.wallet.findUniqueOrThrow({
    where: { systemCode: SystemWalletCode.SETTLEMENT },
  });
  assert.equal(Number(wCAfterRefund.balance), 300000, 'User C được hoàn trả đủ 80,000 VND');
  assert.equal(
    Number(settlementAfter.balance),
    Number(settlementBefore.balance),
    'Ví SETTLEMENT bảo toàn số dư sau khi hoàn tiền đối ứng'
  );

  // --- NGHIỆM THU 3: TỔNG TOÀN HỆ THỐNG BẢO TOÀN (TỔNG THAY ĐỔI = 0) ---
  const totalAfter = (await wPrisma.wallet.aggregate({ _sum: { balance: true } }))._sum.balance;
  assert.equal(
    Number(totalAfter) - Number(totalBefore),
    0,
    'Tổng số dư toàn hệ thống trước và sau hoàn tiền phải bằng nhau (bảo toàn số dư)'
  );

  // Dọn dẹp
  await pPrisma.paymentHistory.deleteMany({ where: { paymentId: { in: [paymentP2P.id, paymentNonP2P.id] } } });
  await pPrisma.outboxEvent.deleteMany({ where: { aggregateId: { in: [paymentP2P.id, paymentNonP2P.id] } } });
  await pPrisma.payment.deleteMany({ where: { id: { in: [paymentP2P.id, paymentNonP2P.id] } } });
});

test('K13-11: Nghiệm thu 1 - Giả lập worker chết giữa chừng rồi chạy lại: đúng 1 bút toán hoàn ở wallet', async () => {
  const userX = await createWallet(400000);
  const userY = await createWallet(100000);

  const refCapture = `crash_test_hold_${randomUUID()}`;
  const expiry = new Date(Date.now() + 60000).toISOString();
  await holdService.createHold(userX.userId, '70000', refCapture, expiry, OwnerType.USER, userY.userId);
  await holdService.captureHold(userX.userId, refCapture);

  const payment = await createPayment({
    userId: userX.userId,
    destinationUserId: userY.userId,
    amount: 70000,
    holdId: refCapture,
  });

  // 1. Admin khởi tạo hoàn tiền -> REFUNDING
  await paymentService.refund(payment.id, 'admin_k13', 'ADMIN');

  // 2. GIẢ LẬP WORKER CHẾT GIỮA CHỪNG:
  // Wallet đã ghi bút toán hoàn tiền thành công, nhưng worker bị crash ngay lập tức trước khi kịp update DB payment
  const refundRefId = `refund_${payment.id}`;
  await walletClient.refundCapture(userX.userId, refCapture, refundRefId, '70000.00');

  // Lúc này tại payment: Payment VẪN đang là REFUNDING
  const paymentBeforeCrash = await pPrisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  assert.equal(paymentBeforeCrash.status, PaymentStatus.REFUNDING);

  // Đánh dấu 1 lần thử bị gián đoạn (timeout/crash)
  await pPrisma.payment.update({
    where: { id: payment.id },
    data: { refundAttempts: 1 },
  });

  // 3. WORKER PHỤC HỒI VÀ CHẠY LẠI
  // Worker claim lại event và xử lý
  const claims = await claimRefundOutboxEvents(pPrisma as any, new Date(), payment.id);
  assert.ok(claims.length >= 1);
  const claim = claims[0];

  const recoverResult = await processRefundEvent(claim, {
    prismaClient: pPrisma as any,
    walletClient,
  });
  assert.equal(recoverResult.status, 'COMPLETED');

  // 4. KIỂM TRA NGHIỆM THU 1:
  // - Payment chuyển sang REFUNDED
  const paymentAfterRecover = await pPrisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  assert.equal(paymentAfterRecover.status, PaymentStatus.REFUNDED);
  assert.ok(paymentAfterRecover.refundedAt);

  // - Outbox payment.refunded được sinh ra
  const refundedEvents = await pPrisma.outboxEvent.findMany({
    where: { aggregateId: payment.id, eventType: 'payment.refunded' },
  });
  assert.equal(refundedEvents.length, 1);

  // - TẠI VÍ: Đúng DUY NHẤT 1 bút toán hoàn (2 LedgerEntry: 1 Nợ, 1 Có)
  const ledgerEntries = await wPrisma.ledgerEntry.findMany({
    where: { referenceId: refundRefId },
  });
  assert.equal(
    ledgerEntries.length,
    2,
    'Chỉ có ĐÚNG 1 bút toán hoàn (1 Nợ và 1 Có) tại wallet, không bị hoàn đôi khi worker chạy lại'
  );

  // - Số dư User X được hoàn lại chính xác 70,000 VND
  const wXFinal = await wPrisma.wallet.findUniqueOrThrow({ where: { id: userX.wallet.id } });
  assert.equal(Number(wXFinal.balance), 400000);

  // Dọn dẹp
  await pPrisma.paymentHistory.deleteMany({ where: { paymentId: payment.id } });
  await pPrisma.outboxEvent.deleteMany({ where: { aggregateId: payment.id } });
  await pPrisma.payment.delete({ where: { id: payment.id } });
});

test('K13-11: Nghiệm thu 2 - Ví đích thiếu tiền: REFUND_FAILED kèm lý do, báo Admin, không retry, không tạo tiền', async () => {
  const userSender = await createWallet(300000);
  const userReceiver = await createWallet(0);

  const refCapture = `insufficient_hold_${randomUUID()}`;
  const expiry = new Date(Date.now() + 60000).toISOString();

  // Người gửi nạp và chuyển 100,000 VND cho người nhận
  await holdService.createHold(userSender.userId, '100000', refCapture, expiry, OwnerType.USER, userReceiver.userId);
  await holdService.captureHold(userSender.userId, refCapture);

  // Người nhận sau đó tiêu hết tiền (ví receiver về 0đ)
  await wPrisma.wallet.update({
    where: { id: userReceiver.wallet.id },
    data: { balance: 0 },
  });

  const payment = await createPayment({
    userId: userSender.userId,
    destinationUserId: userReceiver.userId,
    amount: 100000,
    holdId: refCapture,
  });

  // 1. Admin khởi tạo hoàn tiền
  await paymentService.refund(payment.id, 'admin_k13', 'ADMIN');

  // 2. Worker chạy xử lý
  await drainRefundOutbox({ prismaClient: pPrisma as any, walletClient });

  // 3. KIỂM TRA NGHIỆM THU 2:
  const paymentFailed = await pPrisma.payment.findUniqueOrThrow({ where: { id: payment.id } });

  // (a) Trạng thái là REFUND_FAILED
  assert.equal(paymentFailed.status, PaymentStatus.REFUND_FAILED);

  // (b) Ghi failureCode và failureReason rõ ràng
  assert.equal(paymentFailed.failureCode, 'INSUFFICIENT_FUNDS');
  assert.ok(paymentFailed.failureReason, 'failureReason must be set');

  // (c) Bật cờ can thiệp (Admin Alert)
  assert.equal(paymentFailed.needsAttention, true);

  // (d) Phát sinh sự kiện payment.refund_failed
  const failedEvents = await pPrisma.outboxEvent.findMany({
    where: { aggregateId: payment.id, eventType: 'payment.refund_failed' },
  });
  assert.equal(failedEvents.length, 1);

  // (e) Outbox gốc bị đánh dấu FAILED -> KHÔNG RETRY VÔ HẠN
  const requestedEvents = await pPrisma.outboxEvent.findMany({
    where: { aggregateId: payment.id, eventType: 'payment.refund_requested' },
  });
  assert.equal(requestedEvents[0].status, OutboxEventStatus.FAILED);

  // (f) KHÔNG TẠO TIỀN KHỐNG: Ví receiver vẫn là 0, ví sender vẫn là 200,000đ (không bị cộng tiền vô căn cứ)
  const wSenderFinal = await wPrisma.wallet.findUniqueOrThrow({ where: { id: userSender.wallet.id } });
  const wReceiverFinal = await wPrisma.wallet.findUniqueOrThrow({ where: { id: userReceiver.wallet.id } });
  assert.equal(Number(wReceiverFinal.balance), 0);
  assert.equal(Number(wSenderFinal.balance), 200000);

  // Dọn dẹp
  await pPrisma.paymentHistory.deleteMany({ where: { paymentId: payment.id } });
  await pPrisma.outboxEvent.deleteMany({ where: { aggregateId: payment.id } });
  await pPrisma.payment.delete({ where: { id: payment.id } });
});

test('K13-11: Hạn mức ngày của người dùng không bị hoàn lại sau khi refund payment', async () => {
  const userSender = await createWallet(400000);
  const userReceiver = await createWallet(50000);

  const refCapture = `limit_test_hold_${randomUUID()}`;
  const expiry = new Date(Date.now() + 60000).toISOString();
  await holdService.createHold(userSender.userId, '60000', refCapture, expiry, OwnerType.USER, userReceiver.userId);
  await holdService.captureHold(userSender.userId, refCapture);

  // createHold đã ghi nhận hạn mức ngày qua LimitService
  const today = new Date().toISOString().slice(0, 10);
  const usageBefore = await wPrisma.userDailyUsage.findUniqueOrThrow({
    where: { userId_day: { userId: userSender.userId, day: today } },
  });
  assert.equal(Number(usageBefore.spentDay), 60000);

  const payment = await createPayment({
    userId: userSender.userId,
    destinationUserId: userReceiver.userId,
    amount: 60000,
    holdId: refCapture,
  });

  // Thực hiện hoàn tiền thành công
  await paymentService.refund(payment.id, 'admin_k13', 'ADMIN');
  await drainRefundOutbox({ prismaClient: pPrisma as any, walletClient });

  // Kiểm tra Payment đã REFUNDED
  const paymentRefunded = await pPrisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  assert.equal(paymentRefunded.status, PaymentStatus.REFUNDED);

  // Kiểm tra UserDailyUsage: Hạn mức ngày KHÔNG bị trừ ngược / không hoàn lại
  const usageAfter = await wPrisma.userDailyUsage.findUniqueOrThrow({
    where: { userId_day: { userId: userSender.userId, day: today } },
  });
  assert.equal(
    Number(usageAfter.spentDay),
    Number(usageBefore.spentDay),
    'Hạn mức ngày của người dùng KHÔNG bị hoàn lại sau khi hoàn tiền thanh toán'
  );

  // Dọn dẹp
  await wPrisma.userDailyUsage.deleteMany({ where: { userId: userSender.userId } });
  await pPrisma.paymentHistory.deleteMany({ where: { paymentId: payment.id } });
  await pPrisma.outboxEvent.deleteMany({ where: { aggregateId: payment.id } });
  await pPrisma.payment.delete({ where: { id: payment.id } });
});
