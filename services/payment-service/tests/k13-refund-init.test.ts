import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient, PaymentStatus, PaymentType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PaymentService } from '../src/services/payment.service';
import { DomainException } from '../src/utils/domain.exception';
import { createTestGatewayToken } from 'finvault-internal-auth';

const prisma = new PrismaClient();
const paymentService = new PaymentService();

async function createTestPayment(status: PaymentStatus = PaymentStatus.SUCCESS, amount = 100000) {
  const id = randomUUID();
  const userId = randomUUID();
  const payment = await prisma.payment.create({
    data: {
      id,
      userId,
      amount,
      type: PaymentType.BUS_TICKET,
      status,
      referenceId: `ref_${randomUUID()}`,
      requestHash: `hash_${randomUUID()}`,
      idempotencyKey: `idem_${randomUUID()}`,
      idempotencyExpiresAt: new Date(Date.now() + 86400000),
      callbackTopic: 'payment.order_paid',
    },
  });
  return payment;
}

test('K13-7: Khởi tạo saga hoàn tiền thành công chuyển sang REFUNDING và ghi outbox event', async () => {
  const payment = await createTestPayment(PaymentStatus.SUCCESS, 150000);

  const result = await paymentService.refund(payment.id, 'admin_1', 'ADMIN');

  assert.equal(result.status, PaymentStatus.REFUNDING);
  assert.equal(result.replayed, false);
  assert.ok(result.refundRequestedAt);

  // Check DB Payment
  const dbPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  assert.equal(dbPayment.status, PaymentStatus.REFUNDING);
  assert.ok(dbPayment.refundRequestedAt);

  // Check OutboxEvent
  const outboxEvents = await prisma.outboxEvent.findMany({
    where: { aggregateId: payment.id, eventType: 'payment.refund_requested' },
  });
  assert.equal(outboxEvents.length, 1);
  const event = outboxEvents[0];
  const payload = event.payload as any;
  assert.equal(payload.paymentId, payment.id);
  assert.equal(payload.referenceId, `refund_${payment.id}`);
  assert.equal(payload.amount, '150000.00');
  assert.equal(payload.requestedBy, 'admin_1');

  // Clean up
  await prisma.paymentHistory.deleteMany({ where: { paymentId: payment.id } });
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: payment.id } });
  await prisma.payment.delete({ where: { id: payment.id } });
});

test('K13-7: Gọi lại khi đang REFUNDING hoặc đã REFUNDED trả lũy đẳng không tạo thêm event', async () => {
  const payment = await createTestPayment(PaymentStatus.SUCCESS, 200000);

  // First call -> REFUNDING
  const res1 = await paymentService.refund(payment.id, 'admin_1', 'ADMIN');
  assert.equal(res1.status, PaymentStatus.REFUNDING);
  assert.equal(res1.replayed, false);

  // Second call while REFUNDING -> replayed: true
  const res2 = await paymentService.refund(payment.id, 'admin_1', 'ADMIN');
  assert.equal(res2.status, PaymentStatus.REFUNDING);
  assert.equal(res2.replayed, true);

  // Check outbox events count is STILL exactly 1
  let eventsCount = await prisma.outboxEvent.count({
    where: { aggregateId: payment.id, eventType: 'payment.refund_requested' },
  });
  assert.equal(eventsCount, 1, 'Outbox event must not be duplicated on replay');

  // Manually update status to REFUNDED to test replay on REFUNDED
  await prisma.payment.update({
    where: { id: payment.id },
    data: { status: PaymentStatus.REFUNDED, refundedAt: new Date() },
  });

  const res3 = await paymentService.refund(payment.id, 'admin_1', 'ADMIN');
  assert.equal(res3.status, PaymentStatus.REFUNDED);
  assert.equal(res3.replayed, true);

  eventsCount = await prisma.outboxEvent.count({
    where: { aggregateId: payment.id, eventType: 'payment.refund_requested' },
  });
  assert.equal(eventsCount, 1, 'Still exactly 1 outbox event');

  // Clean up
  await prisma.paymentHistory.deleteMany({ where: { paymentId: payment.id } });
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: payment.id } });
  await prisma.payment.delete({ where: { id: payment.id } });
});

test('K13-7: Trạng thái khác SUCCESS bị 4xx mã lỗi rõ', async () => {
  // 1. PENDING -> INVALID_PAYMENT_STATUS
  const pendingPayment = await createTestPayment(PaymentStatus.PENDING, 50000);
  await assert.rejects(
    async () => {
      await paymentService.refund(pendingPayment.id);
    },
    (err: any) => {
      assert(err instanceof DomainException);
      assert.equal(err.code, 'INVALID_PAYMENT_STATUS');
      assert.equal(err.status, 409);
      return true;
    }
  );

  // 2. REFUND_FAILED -> REFUND_ALREADY_FAILED
  const failedPayment = await createTestPayment(PaymentStatus.REFUND_FAILED, 50000);
  await assert.rejects(
    async () => {
      await paymentService.refund(failedPayment.id);
    },
    (err: any) => {
      assert(err instanceof DomainException);
      assert.equal(err.code, 'REFUND_ALREADY_FAILED');
      assert.equal(err.status, 409);
      return true;
    }
  );

  // Clean up
  await prisma.payment.deleteMany({ where: { id: { in: [pendingPayment.id, failedPayment.id] } } });
});

test('K13-7: Route POST /:id/refund phân quyền - user thường 403, ADMIN và INTERNAL được phép', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const internalKey = process.env.INTERNAL_KEY || 'default_test_key';
  process.env.INTERNAL_KEY = internalKey;

  try {
    const dummyId = randomUUID();

    // 1. Không có auth -> 401
    const resNoAuth = await fetch(`${baseUrl}/api/payments/${dummyId}/refund`, {
      method: 'POST',
    });
    assert.equal(resNoAuth.status, 401);

    // 2. User thường (role: USER) -> 403 FORBIDDEN
    const userToken = createTestGatewayToken(randomUUID(), 'USER');
    const resUser = await fetch(`${baseUrl}/api/payments/${dummyId}/refund`, {
      method: 'POST',
      headers: {
        'x-gateway-token': userToken,
      },
    });
    assert.equal(resUser.status, 403);
    const bodyUser = await resUser.json();
    assert.equal(bodyUser.error?.code, 'FORBIDDEN');

    // 3. Service nội bộ (x-internal-key) -> vượt qua auth (nhận 404 NOT_FOUND vì dummyId không tồn tại)
    const resInternal = await fetch(`${baseUrl}/api/payments/${dummyId}/refund`, {
      method: 'POST',
      headers: {
        'x-internal-key': internalKey,
      },
    });
    assert.equal(resInternal.status, 404);

    // 4. Quản trị viên (role: ADMIN) -> vượt qua auth (nhận 404 NOT_FOUND vì dummyId không tồn tại)
    const adminToken = createTestGatewayToken(randomUUID(), 'ADMIN');
    const resAdmin = await fetch(`${baseUrl}/api/payments/${dummyId}/refund`, {
      method: 'POST',
      headers: {
        'x-gateway-token': adminToken,
      },
    });
    assert.equal(resAdmin.status, 404);
  } finally {
    server.close();
  }
});
