import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient, PaymentStatus, PaymentType, OutboxEventStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { claimRefundOutboxEvents, processRefundEvent } from '../src/jobs/refund.worker';
import { DomainException } from '../src/utils/domain.exception';

const prisma = new PrismaClient();

test('K13-10: Ví thiếu tiền (INSUFFICIENT_FUNDS) -> REFUND_FAILED, không retry, bật needsAttention, sinh outbox payment.refund_failed', async () => {
  const paymentId = randomUUID();
  const userId = randomUUID();
  const holdId = `hold_${randomUUID()}`;
  const referenceId = `refund_${paymentId}`;

  // 1. Tạo Payment REFUNDING
  await prisma.payment.create({
    data: {
      id: paymentId,
      userId,
      amount: 500000,
      type: PaymentType.WALLET_TRANSFER,
      status: PaymentStatus.REFUNDING,
      holdId,
      referenceId: `ref_${randomUUID()}`,
      requestHash: `hash_${randomUUID()}`,
      idempotencyKey: `idem_${randomUUID()}`,
      idempotencyExpiresAt: new Date(Date.now() + 86400000),
      callbackTopic: 'payment.order_paid',
      refundRequestedAt: new Date(),
      refundAttempts: 0,
      needsAttention: false,
    },
  });

  const eventId = randomUUID();
  await prisma.outboxEvent.create({
    data: {
      id: eventId,
      aggregateId: paymentId,
      eventType: 'payment.refund_requested',
      topic: 'payment.refund_requested',
      payload: {
        paymentId,
        referenceId,
        originalHoldId: holdId,
        userId,
        amount: '500000.00',
        requestedBy: 'admin_test',
        requestedAt: new Date().toISOString(),
      },
      status: OutboxEventStatus.PENDING,
    },
  });

  // Mock wallet ném lỗi INSUFFICIENT_FUNDS (422)
  const mockWalletInsufficient = {
    refundCapture: async () => {
      throw new DomainException(422, 'INSUFFICIENT_FUNDS', 'Ví đích không đủ số dư để hoàn tiền (số dư thiếu: 300000)');
    },
    lookupTransaction: async () => ({ exists: false }),
  };

  try {
    const claims = await claimRefundOutboxEvents(prisma, new Date(), paymentId);
    const myClaim = claims.find((c) => c.id === eventId);
    assert.ok(myClaim);

    const result = await processRefundEvent(myClaim, {
      prismaClient: prisma,
      walletClient: mockWalletInsufficient as any,
    });
    assert.equal(result.status, 'FAILED');

    // 1. Payment chuyển sang REFUND_FAILED
    const failedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    assert.equal(failedPayment.status, PaymentStatus.REFUND_FAILED);
    assert.equal(failedPayment.failureCode, 'INSUFFICIENT_FUNDS');
    assert.ok(failedPayment.failureReason?.includes('Ví đích không đủ số dư'));
    // 2. Cờ can thiệp (needsAttention) được BẬT
    assert.equal(failedPayment.needsAttention, true);

    // 3. PaymentHistory được ghi nhận
    const histories = await prisma.paymentHistory.findMany({ where: { paymentId } });
    const failHistory = histories.find((h) => h.toStatus === PaymentStatus.REFUND_FAILED);
    assert.ok(failHistory);
    assert.equal(failHistory.fromStatus, PaymentStatus.REFUNDING);

    // 4. Sinh OutboxEvent payment.refund_failed
    const failedEvents = await prisma.outboxEvent.findMany({
      where: { aggregateId: paymentId, eventType: 'payment.refund_failed' },
    });
    assert.equal(failedEvents.length, 1);
    const failPayload = failedEvents[0].payload as any;
    assert.equal(failPayload.paymentId, paymentId);
    assert.equal(failPayload.referenceId, referenceId);
    assert.equal(failPayload.failureCode, 'INSUFFICIENT_FUNDS');
    assert.ok(failPayload.failureReason?.includes('Ví đích không đủ số dư'));

    // 5. OutboxEvent cũ chuyển sang FAILED (KHÔNG retry vô hạn)
    const originalEvent = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(originalEvent.status, OutboxEventStatus.FAILED);
    assert.equal(originalEvent.lockToken, null);
  } finally {
    await prisma.paymentHistory.deleteMany({ where: { paymentId } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: paymentId } });
    await prisma.payment.delete({ where: { id: paymentId } });
  }
});

test('K13-10: Capture không tồn tại (CAPTURE_NOT_FOUND, 404) -> REFUND_FAILED và dừng retry', async () => {
  const paymentId = randomUUID();
  const userId = randomUUID();
  const holdId = `hold_${randomUUID()}`;
  const referenceId = `refund_${paymentId}`;

  await prisma.payment.create({
    data: {
      id: paymentId,
      userId,
      amount: 70000,
      type: PaymentType.BUS_TICKET,
      status: PaymentStatus.REFUNDING,
      holdId,
      referenceId: `ref_${randomUUID()}`,
      requestHash: `hash_${randomUUID()}`,
      idempotencyKey: `idem_${randomUUID()}`,
      idempotencyExpiresAt: new Date(Date.now() + 86400000),
      callbackTopic: 'payment.order_paid',
      refundRequestedAt: new Date(),
      needsAttention: false,
    },
  });

  const eventId = randomUUID();
  await prisma.outboxEvent.create({
    data: {
      id: eventId,
      aggregateId: paymentId,
      eventType: 'payment.refund_requested',
      topic: 'payment.refund_requested',
      payload: {
        paymentId,
        referenceId,
        originalHoldId: holdId,
        userId,
        amount: '70000.00',
        requestedBy: 'admin_test',
        requestedAt: new Date().toISOString(),
      },
      status: OutboxEventStatus.PENDING,
    },
  });

  // Mock wallet trả về 404 CAPTURE_NOT_FOUND
  const mockWalletCaptureNotFound = {
    refundCapture: async () => {
      throw new DomainException(404, 'CAPTURE_NOT_FOUND', 'Original capture transaction not found in wallet');
    },
    lookupTransaction: async () => ({ exists: false }),
  };

  try {
    const claims = await claimRefundOutboxEvents(prisma, new Date(), paymentId);
    const myClaim = claims.find((c) => c.id === eventId);
    assert.ok(myClaim);

    const result = await processRefundEvent(myClaim, {
      prismaClient: prisma,
      walletClient: mockWalletCaptureNotFound as any,
    });
    assert.equal(result.status, 'FAILED');

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    assert.equal(payment.status, PaymentStatus.REFUND_FAILED);
    assert.equal(payment.failureCode, 'CAPTURE_NOT_FOUND');
    assert.equal(payment.needsAttention, true);

    const originalEvent = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(originalEvent.status, OutboxEventStatus.FAILED);
  } finally {
    await prisma.paymentHistory.deleteMany({ where: { paymentId } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: paymentId } });
    await prisma.payment.delete({ where: { id: paymentId } });
  }
});
