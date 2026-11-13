import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient, PaymentStatus, PaymentType, OutboxEventStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { claimRefundOutboxEvents, processRefundEvent } from '../src/jobs/refund.worker';
import { DomainException } from '../src/utils/domain.exception';

const prisma = new PrismaClient();

test('K13-9: Timeout/5xx từ wallet giữ trạng thái REFUNDING, tăng refundAttempts và backoff', async () => {
  const paymentId = randomUUID();
  const userId = randomUUID();
  const holdId = `hold_${randomUUID()}`;

  // 1. Tạo Payment REFUNDING với refundAttempts = 0
  await prisma.payment.create({
    data: {
      id: paymentId,
      userId,
      amount: 80000,
      type: PaymentType.BILL_PAYMENT,
      status: PaymentStatus.REFUNDING,
      holdId,
      referenceId: `ref_${randomUUID()}`,
      requestHash: `hash_${randomUUID()}`,
      idempotencyKey: `idem_${randomUUID()}`,
      idempotencyExpiresAt: new Date(Date.now() + 86400000),
      callbackTopic: 'payment.order_paid',
      refundRequestedAt: new Date(),
      refundAttempts: 0,
    },
  });

  const eventId = randomUUID();
  const referenceId = `refund_${paymentId}`;
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
        amount: '80000.00',
        requestedBy: 'admin_test',
        requestedAt: new Date().toISOString(),
      },
      status: OutboxEventStatus.PENDING,
    },
  });

  // Mock walletClient ném ra lỗi 504 GATEWAY_TIMEOUT
  const mockWalletTimeout = {
    refundCapture: async () => {
      throw new DomainException(504, 'GATEWAY_TIMEOUT', 'Wallet response timed out');
    },
    lookupTransaction: async () => ({ exists: false }),
  };

  try {
    const claims = await claimRefundOutboxEvents(prisma, new Date(), paymentId);
    const myClaim = claims.find((c) => c.id === eventId);
    assert.ok(myClaim);

    const result = await processRefundEvent(myClaim, {
      prismaClient: prisma,
      walletClient: mockWalletTimeout as any,
    });
    assert.equal(result.status, 'RETRY');

    // Kiểm tra Payment: VẪN là REFUNDING (KHÔNG bị đổi sang REFUND_FAILED)
    const paymentAfterTimeout = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    assert.equal(paymentAfterTimeout.status, PaymentStatus.REFUNDING);
    assert.equal(paymentAfterTimeout.refundAttempts, 1);
    assert.ok(paymentAfterTimeout.nextRefundAttemptAt);
    assert.ok(paymentAfterTimeout.nextRefundAttemptAt.getTime() > Date.now());

    // Kiểm tra OutboxEvent: chuyển về PENDING, tăng retryCount, giải phóng lockToken
    const eventAfterTimeout = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(eventAfterTimeout.status, OutboxEventStatus.PENDING);
    assert.equal(eventAfterTimeout.retryCount, 1);
    assert.ok(eventAfterTimeout.nextRetryAt);
    assert.equal(eventAfterTimeout.lockToken, null);
  } finally {
    await prisma.paymentHistory.deleteMany({ where: { paymentId } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: paymentId } });
    await prisma.payment.delete({ where: { id: paymentId } });
  }
});

test('K13-9: Retry khi wallet đã hoàn thành giao dịch (tra cứu lookup thành công) chuyển REFUNDED', async () => {
  const paymentId = randomUUID();
  const userId = randomUUID();
  const holdId = `hold_${randomUUID()}`;
  const referenceId = `refund_${paymentId}`;

  // 1. Payment đang REFUNDING và đã có 1 lần thử trước đó (refundAttempts = 1)
  await prisma.payment.create({
    data: {
      id: paymentId,
      userId,
      amount: 95000,
      type: PaymentType.PHONE_TOPUP,
      status: PaymentStatus.REFUNDING,
      holdId,
      referenceId: `ref_${randomUUID()}`,
      requestHash: `hash_${randomUUID()}`,
      idempotencyKey: `idem_${randomUUID()}`,
      idempotencyExpiresAt: new Date(Date.now() + 86400000),
      callbackTopic: 'payment.order_paid',
      refundRequestedAt: new Date(),
      refundAttempts: 1,
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
        amount: '95000.00',
        requestedBy: 'admin_test',
        requestedAt: new Date().toISOString(),
      },
      status: OutboxEventStatus.PENDING,
    },
  });

  let lookupCalled = false;
  let refundCaptureCalled = false;
  const mockWalletWithCompletedLookup = {
    lookupTransaction: async (ref: string) => {
      lookupCalled = true;
      assert.equal(ref, referenceId);
      return {
        exists: true,
        transactionId: 'tx_discovered_on_lookup_333',
        status: 'COMPLETED',
        createdAt: '2026-11-04T12:30:00.000Z',
      };
    },
    refundCapture: async () => {
      refundCaptureCalled = true;
      throw new Error('Should not call refundCapture if lookup found completed transaction');
    },
  };

  try {
    const claims = await claimRefundOutboxEvents(prisma, new Date(), paymentId);
    const myClaim = claims.find((c) => c.id === eventId);
    assert.ok(myClaim);

    const result = await processRefundEvent(myClaim, {
      prismaClient: prisma,
      walletClient: mockWalletWithCompletedLookup as any,
    });
    assert.equal(result.status, 'COMPLETED');
    assert.ok(lookupCalled, 'Lookup must be called first when refundAttempts > 0');
    assert.equal(refundCaptureCalled, false, 'refundCapture must NOT be called if lookup succeeded');

    // Kiểm tra Payment đã sang REFUNDED
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    assert.equal(payment.status, PaymentStatus.REFUNDED);
    assert.ok(payment.refundedAt);

    // Kiểm tra Outbox payment.refunded
    const refundedEvents = await prisma.outboxEvent.findMany({
      where: { aggregateId: paymentId, eventType: 'payment.refunded' },
    });
    assert.equal(refundedEvents.length, 1);
    const payload = refundedEvents[0].payload as any;
    assert.equal(payload.walletTransactionId, 'tx_discovered_on_lookup_333');

    // Kiểm tra Outbox cũ là SENT
    const originalEvent = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(originalEvent.status, OutboxEventStatus.SENT);
  } finally {
    await prisma.paymentHistory.deleteMany({ where: { paymentId } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: paymentId } });
    await prisma.payment.delete({ where: { id: paymentId } });
  }
});

test('K13-9: Retry khi wallet chưa xử lý (lookup báo false) thì gọi lại refundCapture với CÙNG referenceId', async () => {
  const paymentId = randomUUID();
  const userId = randomUUID();
  const holdId = `hold_${randomUUID()}`;
  const referenceId = `refund_${paymentId}`;

  await prisma.payment.create({
    data: {
      id: paymentId,
      userId,
      amount: 110000,
      type: PaymentType.WALLET_TRANSFER,
      status: PaymentStatus.REFUNDING,
      holdId,
      referenceId: `ref_${randomUUID()}`,
      requestHash: `hash_${randomUUID()}`,
      idempotencyKey: `idem_${randomUUID()}`,
      idempotencyExpiresAt: new Date(Date.now() + 86400000),
      callbackTopic: 'payment.order_paid',
      refundRequestedAt: new Date(),
      refundAttempts: 1,
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
        amount: '110000.00',
        requestedBy: 'admin_test',
        requestedAt: new Date().toISOString(),
      },
      status: OutboxEventStatus.PENDING,
    },
  });

  let lookupCalled = false;
  let refundCaptureCalledWithRef: string | null = null;
  const mockWalletUnprocessed = {
    lookupTransaction: async (ref: string) => {
      lookupCalled = true;
      assert.equal(ref, referenceId);
      return { exists: false };
    },
    refundCapture: async (_uid: string, _origRef: string, refId: string, amt: string) => {
      refundCaptureCalledWithRef = refId;
      return {
        transactionId: 'tx_retry_success_444',
        referenceId: refId,
        status: 'COMPLETED',
        amount: amt,
      };
    },
  };

  try {
    const claims = await claimRefundOutboxEvents(prisma, new Date(), paymentId);
    const myClaim = claims.find((c) => c.id === eventId);
    assert.ok(myClaim);

    const result = await processRefundEvent(myClaim, {
      prismaClient: prisma,
      walletClient: mockWalletUnprocessed as any,
    });
    assert.equal(result.status, 'COMPLETED');
    assert.ok(lookupCalled);
    assert.equal(refundCaptureCalledWithRef, referenceId, 'Must reuse the SAME referenceId on retry');

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    assert.equal(payment.status, PaymentStatus.REFUNDED);
  } finally {
    await prisma.paymentHistory.deleteMany({ where: { paymentId } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: paymentId } });
    await prisma.payment.delete({ where: { id: paymentId } });
  }
});
