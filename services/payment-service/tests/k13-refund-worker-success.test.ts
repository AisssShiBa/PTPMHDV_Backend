import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient, PaymentStatus, PaymentType, OutboxEventStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { claimRefundOutboxEvents, processRefundEvent } from '../src/jobs/refund.worker';

const prisma = new PrismaClient();

test('K13-8: Worker xử lý thành công payment.refund_requested -> chuyển REFUNDED và sinh outbox payment.refunded', async () => {
  const paymentId = randomUUID();
  const userId = randomUUID();
  const holdId = `hold_${randomUUID()}`;
  const amount = 120000;

  // 1. Tạo Payment ở trạng thái REFUNDING
  await prisma.payment.create({
    data: {
      id: paymentId,
      userId,
      amount,
      type: PaymentType.BUS_TICKET,
      status: PaymentStatus.REFUNDING,
      holdId,
      referenceId: `ref_${randomUUID()}`,
      requestHash: `hash_${randomUUID()}`,
      idempotencyKey: `idem_${randomUUID()}`,
      idempotencyExpiresAt: new Date(Date.now() + 86400000),
      callbackTopic: 'payment.order_paid',
      refundRequestedAt: new Date(),
    },
  });

  // 2. Tạo OutboxEvent payment.refund_requested
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
        amount: '120000.00',
        requestedBy: 'admin_test',
        requestedAt: new Date().toISOString(),
      },
      status: OutboxEventStatus.PENDING,
    },
  });

  // 3. Mock walletClient
  let walletCalledWith: any = null;
  const mockWalletClient = {
    refundCapture: async (uid: string, origRef: string, refId: string, amt: string) => {
      walletCalledWith = { uid, origRef, refId, amt };
      return {
        transactionId: 'tx_refund_success_999',
        referenceId: refId,
        status: 'COMPLETED',
        amount: amt,
      };
    },
    lookupTransaction: async () => ({ exists: false }),
  };

  try {
    // 4. Claim outbox event specifically for this aggregateId
    const claims = await claimRefundOutboxEvents(prisma, new Date(), paymentId);
    const myClaim = claims.find((c) => c.id === eventId);
    assert.ok(myClaim, 'Event must be claimed by refund worker');
    assert.ok(myClaim.lockToken);

    // 5. Xử lý event
    const processResult = await processRefundEvent(myClaim, {
      prismaClient: prisma,
      walletClient: mockWalletClient as any,
    });
    assert.equal(processResult.status, 'COMPLETED');

    // Kiểm tra Wallet client được gọi đúng tham số
    assert.ok(walletCalledWith);
    assert.equal(walletCalledWith.uid, userId);
    assert.equal(walletCalledWith.origRef, holdId);
    assert.equal(walletCalledWith.refId, referenceId);
    assert.equal(walletCalledWith.amt, '120000.00');

    // 6. Kiểm tra Payment đã chuyển sang REFUNDED
    const updatedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    assert.equal(updatedPayment.status, PaymentStatus.REFUNDED);
    assert.ok(updatedPayment.refundedAt);

    // Kiểm tra PaymentHistory
    const histories = await prisma.paymentHistory.findMany({ where: { paymentId } });
    const refundHistory = histories.find((h) => h.toStatus === PaymentStatus.REFUNDED);
    assert.ok(refundHistory);
    assert.equal(refundHistory.fromStatus, PaymentStatus.REFUNDING);

    // 7. Kiểm tra OutboxEvent payment.refunded được sinh ra
    const refundedEvents = await prisma.outboxEvent.findMany({
      where: { aggregateId: paymentId, eventType: 'payment.refunded' },
    });
    assert.equal(refundedEvents.length, 1);
    const refundedPayload = refundedEvents[0].payload as any;
    assert.equal(refundedPayload.paymentId, paymentId);
    assert.equal(refundedPayload.referenceId, referenceId);
    assert.equal(refundedPayload.walletTransactionId, 'tx_refund_success_999');
    assert.equal(refundedPayload.status, 'REFUNDED');
    assert.equal(refundedPayload.amount, '120000.00');

    // 8. Kiểm tra OutboxEvent cũ đã hoàn tất (status = SENT)
    const originalEvent = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(originalEvent.status, OutboxEventStatus.SENT);
    assert.ok(originalEvent.sentAt);
    assert.equal(originalEvent.lockToken, null);
  } finally {
    // Dọn dẹp
    await prisma.paymentHistory.deleteMany({ where: { paymentId } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: paymentId } });
    await prisma.payment.delete({ where: { id: paymentId } });
  }
});
