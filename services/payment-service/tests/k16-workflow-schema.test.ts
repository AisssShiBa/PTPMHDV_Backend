const paymentDbUrl = process.env.PAYMENT_DATABASE_URL || 'postgresql://postgres:8932ce4c6b28dba8c13430d3317b1e51e4f8838c6b02824423f9b57b69d56d4a@localhost:5432/payment_service?schema=public';

process.env.PAYMENT_DATABASE_URL = paymentDbUrl;
process.env.RABBITMQ_URL = '';

import assert from 'node:assert/strict';
import { test, describe, after } from 'node:test';
import { randomUUID } from 'crypto';
import { PrismaClient as PaymentPrisma, PaymentType, PaymentStatus, IdempotencyStatus } from '@prisma/client';

const prisma = new PaymentPrisma({ datasources: { db: { url: paymentDbUrl } } });

after(async () => {
  await prisma.$disconnect();
});

describe('K16-2: Workflow Schema & Backward Compatibility Test', () => {

  test('Model reads old records where workerLeaseUntil is null and attempt has default 0', async () => {
    const paymentId = randomUUID();
    const userId = randomUUID();

    // Insert direct record without workerLeaseUntil
    const payment = await prisma.payment.create({
      data: {
        id: paymentId,
        userId,
        amount: '25000',
        type: PaymentType.WALLET_TRANSFER,
        referenceId: `ref-${paymentId}`,
        destinationUserId: randomUUID(),
        callbackTopic: 'finvault.events',
        idempotencyKey: `idemp-old-${paymentId}`,
        requestHash: 'dummyhash',
        idempotencyStatus: IdempotencyStatus.PROCESSING,
        idempotencyExpiresAt: new Date(Date.now() + 86400000),
        status: PaymentStatus.PENDING,
        workflow: 'IDLE',
      }
    });

    assert.equal(payment.workerLeaseUntil, null, 'workerLeaseUntil phải là null cho bản ghi cũ');
    assert.equal(payment.attempt, 0, 'attempt mặc định là 0');

    // Đọc lại từ DB
    const fetched = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId }
    });

    assert.equal(fetched.id, paymentId);
    assert.equal(fetched.workerLeaseUntil, null);
    assert.equal(fetched.attempt, 0);
  });

  test('Model can set and query workerLeaseUntil and increment attempt', async () => {
    const paymentId = randomUUID();
    const userId = randomUUID();
    const leaseUntil = new Date(Date.now() + 30000);

    const payment = await prisma.payment.create({
      data: {
        id: paymentId,
        userId,
        amount: '75000',
        type: PaymentType.WALLET_TRANSFER,
        referenceId: `ref-${paymentId}`,
        destinationUserId: randomUUID(),
        callbackTopic: 'finvault.events',
        idempotencyKey: `idemp-lease-${paymentId}`,
        requestHash: 'dummyhash2',
        idempotencyStatus: IdempotencyStatus.PROCESSING,
        idempotencyExpiresAt: new Date(Date.now() + 86400000),
        status: PaymentStatus.PENDING,
        workflow: 'HOLD_CALLING',
        workerLeaseUntil: leaseUntil,
        attempt: 1,
      }
    });

    assert.equal(payment.workflow, 'HOLD_CALLING');
    assert.equal(payment.attempt, 1);
    assert.ok(payment.workerLeaseUntil !== null);

    // Truy vấn bằng index [workflow, workerLeaseUntil]
    const found = await prisma.payment.findFirst({
      where: {
        workflow: 'HOLD_CALLING',
        workerLeaseUntil: { gt: new Date() }
      }
    });

    assert.ok(found !== null, 'Phải tìm thấy bản ghi theo index workflow và workerLeaseUntil');
  });

});
