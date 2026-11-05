import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient, PaymentStatus, PaymentType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { sweepExpiredPayments } from '../src/jobs/payment-expiry.job';
import { paymentExpiredSchema } from 'finvault-events';
import { WalletClient } from '../src/clients/wallet.client';

const prisma = new PrismaClient();

async function createTestPendingPayment(holdExpiresAt: Date = new Date(Date.now() - 5000)) {
  const id = randomUUID();
  const userId = randomUUID();
  const holdId = randomUUID();
  const payment = await prisma.payment.create({
    data: {
      id,
      userId,
      amount: 150000,
      type: PaymentType.WALLET_TRANSFER,
      status: PaymentStatus.PENDING,
      holdId,
      holdExpiresAt,
      referenceId: `ref_${randomUUID()}`,
      requestHash: `hash_${randomUUID()}`,
      idempotencyKey: `idem_${randomUUID()}`,
      idempotencyExpiresAt: new Date(Date.now() + 86400000),
      callbackTopic: 'finvault.events',
    },
  });
  return payment;
}

test('K14-4: payment-expiry khi wallet trả thành công bình thường', async () => {
  const payment = await createTestPendingPayment();

  // Mock wallet releaseHold trả thành công bình thường (RELEASED)
  let releaseHoldCalled = false;
  const mockWallet = {
    releaseHold: async (userId: string, holdId: string) => {
      releaseHoldCalled = true;
      return { success: true, data: { id: holdId, status: 'RELEASED', replayed: false } };
    },
  } as unknown as WalletClient;

  const result = await sweepExpiredPayments({
    paymentId: payment.id,
    walletClient: mockWallet,
  });

  assert.strictEqual(releaseHoldCalled, true, 'WalletClient.releaseHold phải được gọi');
  assert.strictEqual(result.expired, 1);
  assert.strictEqual(result.errors, 0);

  // Kiểm tra trạng thái Payment
  const dbPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  assert.strictEqual(dbPayment.status, PaymentStatus.EXPIRED);

  // Kiểm tra OutboxEvent
  const events = await prisma.outboxEvent.findMany({ where: { aggregateId: payment.id } });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].eventType, 'payment.expired');

  // Dọn dẹp
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: payment.id } });
  await prisma.paymentHistory.deleteMany({ where: { paymentId: payment.id } });
  await prisma.payment.delete({ where: { id: payment.id } });
});

test('K14-4: payment-expiry khi wallet trả idempotent (hold đã EXPIRED do ví nhả trước)', async () => {
  const payment = await createTestPendingPayment();

  // Mock wallet releaseHold trả idempotent EXPIRED (sweeper ví đã nhả trước)
  let releaseHoldCalled = false;
  const mockWallet = {
    releaseHold: async (userId: string, holdId: string) => {
      releaseHoldCalled = true;
      return { success: true, data: { id: holdId, status: 'EXPIRED', replayed: true } };
    },
  } as unknown as WalletClient;

  const result = await sweepExpiredPayments({
    paymentId: payment.id,
    walletClient: mockWallet,
  });

  assert.strictEqual(releaseHoldCalled, true);
  assert.strictEqual(result.expired, 1, 'Payment vẫn được chuyển sang EXPIRED');
  assert.strictEqual(result.errors, 0);

  const dbPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  assert.strictEqual(dbPayment.status, PaymentStatus.EXPIRED);

  const events = await prisma.outboxEvent.findMany({ where: { aggregateId: payment.id } });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].eventType, 'payment.expired');

  // Dọn dẹp
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: payment.id } });
  await prisma.paymentHistory.deleteMany({ where: { paymentId: payment.id } });
  await prisma.payment.delete({ where: { id: payment.id } });
});

test('K14-4: OutboxEvent được ghi đúng schema finvault-events', async () => {
  const payment = await createTestPendingPayment();

  const mockWallet = {
    releaseHold: async () => ({ success: true, data: { status: 'EXPIRED', replayed: true } }),
  } as unknown as WalletClient;

  await sweepExpiredPayments({
    paymentId: payment.id,
    walletClient: mockWallet,
  });

  const event = await prisma.outboxEvent.findFirstOrThrow({
    where: { aggregateId: payment.id, eventType: 'payment.expired' },
  });

  const payload: any = event.payload;
  assert.strictEqual(payload.paymentId, payment.id);
  assert.strictEqual(payload.senderId, payment.userId);

  // Validate bằng schema chuẩn của FinVault Events
  const parseResult = paymentExpiredSchema.safeParse(payload);
  assert.strictEqual(parseResult.success, true, `Schema validation failed: ${JSON.stringify(parseResult.error)}`);

  // Dọn dẹp
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: payment.id } });
  await prisma.paymentHistory.deleteMany({ where: { paymentId: payment.id } });
  await prisma.payment.delete({ where: { id: payment.id } });
});

test('K14-4: OutboxEvent không bị nhân bản khi job quét lại (lũy đẳng)', async () => {
  const payment = await createTestPendingPayment();

  const mockWallet = {
    releaseHold: async () => ({ success: true, data: { status: 'EXPIRED', replayed: true } }),
  } as unknown as WalletClient;

  // Lần 1: quét và hết hạn
  const run1 = await sweepExpiredPayments({
    paymentId: payment.id,
    walletClient: mockWallet,
  });
  assert.strictEqual(run1.expired, 1);

  const countAfterRun1 = await prisma.outboxEvent.count({
    where: { aggregateId: payment.id, eventType: 'payment.expired' },
  });
  assert.strictEqual(countAfterRun1, 1);

  // Lần 2: quét lại trên payment đã EXPIRED
  const run2 = await sweepExpiredPayments({
    paymentId: payment.id,
    walletClient: mockWallet,
  });
  assert.strictEqual(run2.expired, 0, 'Không xử lý lại payment đã EXPIRED');
  assert.strictEqual(run2.skipped, 1, 'Payment được bỏ qua');

  const countAfterRun2 = await prisma.outboxEvent.count({
    where: { aggregateId: payment.id, eventType: 'payment.expired' },
  });
  assert.strictEqual(countAfterRun2, 1, 'OutboxEvent tuyệt đối không bị nhân bản khi quét lại');

  // Dọn dẹp
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: payment.id } });
  await prisma.paymentHistory.deleteMany({ where: { paymentId: payment.id } });
  await prisma.payment.delete({ where: { id: payment.id } });
});
