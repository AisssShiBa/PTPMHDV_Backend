import { randomUUID } from 'node:crypto';
import cron from 'node-cron';
import { PrismaClient, PaymentStatus, OutboxEventStatus, Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { WalletClient } from '../clients/wallet.client';

export const REFUND_OUTBOX_BATCH_SIZE = 10;
export const REFUND_OUTBOX_LEASE_MS = 60_000;

const defaultWalletClient = new WalletClient();

export async function claimRefundOutboxEvents(
  prismaClient: PrismaClient,
  now = new Date(),
  aggregateIdPrefix?: string
): Promise<Array<{ id: string; lockToken: string }>> {
  const lockToken = randomUUID();
  const lockedUntil = new Date(now.getTime() + REFUND_OUTBOX_LEASE_MS);
  return prismaClient.$transaction(async (tx) => {
    return tx.$queryRaw<Array<{ id: string; lockToken: string }>>`
      WITH candidates AS (
        SELECT "id"
        FROM "OutboxEvent"
        WHERE "eventType" = 'payment.refund_requested'
          AND (
            ("status" = 'PENDING' AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= ${now}))
            OR ("status" = 'PROCESSING' AND "lockedUntil" <= ${now})
          )
          AND (${aggregateIdPrefix ?? null}::text IS NULL OR "aggregateId" LIKE ${aggregateIdPrefix ? `${aggregateIdPrefix}%` : ''})
        ORDER BY "createdAt" ASC
        LIMIT ${REFUND_OUTBOX_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "OutboxEvent" AS outbox
      SET "status" = 'PROCESSING',
          "lockedUntil" = ${lockedUntil},
          "lockToken" = ${lockToken}::uuid
      FROM candidates
      WHERE outbox."id" = candidates."id"
      RETURNING outbox."id", outbox."lockToken"
    `;
  }, { maxWait: 5000, timeout: 10_000 });
}

export async function processRefundEvent(
  claim: { id: string; lockToken: string },
  dependencies: {
    prismaClient?: PrismaClient;
    walletClient?: Pick<WalletClient, 'refundCapture' | 'lookupTransaction'>;
  } = {}
): Promise<{ status: 'COMPLETED' | 'RETRY' | 'FAILED' | 'IGNORED' }> {
  const db = dependencies.prismaClient ?? prisma;
  const wallet = dependencies.walletClient ?? defaultWalletClient;

  const event = await db.outboxEvent.findFirst({
    where: { id: claim.id, status: OutboxEventStatus.PROCESSING, lockToken: claim.lockToken },
  });
  if (!event) return { status: 'IGNORED' };

  const payload = event.payload as Record<string, any>;
  const paymentId = payload.paymentId || event.aggregateId;
  const referenceId = payload.referenceId || `refund_${paymentId}`;

  const payment = await db.payment.findUnique({ where: { id: paymentId } });
  if (!payment) {
    console.error(`[Refund Worker] Payment ${paymentId} not found for outbox event ${event.id}`);
    await db.outboxEvent.updateMany({
      where: { id: event.id, lockToken: claim.lockToken },
      data: { status: OutboxEventStatus.FAILED, lockToken: null, lockedUntil: null },
    });
    return { status: 'FAILED' };
  }

  // Nếu payment đã ở REFUNDED từ trước (ví dụ do idempotency hoặc lookup thành công)
  if (payment.status === PaymentStatus.REFUNDED) {
    await db.outboxEvent.updateMany({
      where: { id: event.id, lockToken: claim.lockToken },
      data: { status: OutboxEventStatus.SENT, sentAt: new Date(), lockToken: null, lockedUntil: null },
    });
    return { status: 'COMPLETED' };
  }

  // Nếu payment đã ở REFUND_FAILED từ trước
  if (payment.status === PaymentStatus.REFUND_FAILED) {
    await db.outboxEvent.updateMany({
      where: { id: event.id, lockToken: claim.lockToken },
      data: { status: OutboxEventStatus.FAILED, lockToken: null, lockedUntil: null },
    });
    return { status: 'FAILED' };
  }

  // K13-9: Khi đã thử trước đó và bị gián đoạn, tra cứu lookup tại Wallet trước khi gọi lại
  if (payment.refundAttempts > 0) {
    try {
      const lookup = await wallet.lookupTransaction(referenceId);
      if (lookup && lookup.exists && lookup.status === 'COMPLETED') {
        const refundedAt = new Date(lookup.createdAt || Date.now());
        await db.$transaction(async (tx) => {
          await tx.payment.update({
            where: { id: paymentId },
            data: {
              status: PaymentStatus.REFUNDED,
              refundedAt,
              histories: {
                create: {
                  id: randomUUID(),
                  fromStatus: payment.status,
                  toStatus: PaymentStatus.REFUNDED,
                  note: `Refund confirmed via transaction lookup (${lookup.transactionId})`,
                },
              },
            },
          });

          await tx.outboxEvent.create({
            data: {
              id: randomUUID(),
              aggregateId: paymentId,
              eventType: 'payment.refunded',
              topic: 'payment.refunded',
              payload: {
                paymentId,
                referenceId,
                walletTransactionId: lookup.transactionId,
                userId: payment.userId,
                destinationUserId: payment.destinationUserId ?? null,
                amount: new Prisma.Decimal(payment.amount).toFixed(2),
                status: 'REFUNDED',
                refundedAt: refundedAt.toISOString(),
              },
              status: OutboxEventStatus.PENDING,
            },
          });

          await tx.outboxEvent.updateMany({
            where: { id: event.id, lockToken: claim.lockToken },
            data: { status: OutboxEventStatus.SENT, sentAt: new Date(), lockToken: null, lockedUntil: null },
          });
        });
        return { status: 'COMPLETED' };
      }
    } catch (lookupErr: any) {
      console.warn(`[Refund Worker] Transaction lookup failed for ${referenceId}, proceeding to refund:`, lookupErr.message);
    }
  }

  // Gọi wallet để thực hiện hoàn tiền (bút toán ngược)
  const originalReferenceId = payment.holdId || payment.referenceId;
  const amountStr = new Prisma.Decimal(payment.amount).toFixed(2);

  try {
    const refundResult = await wallet.refundCapture(payment.userId, originalReferenceId, referenceId, amountStr);
    const refundedAt = new Date();

    await db.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: PaymentStatus.REFUNDED,
          refundedAt,
          histories: {
            create: {
              id: randomUUID(),
              fromStatus: payment.status,
              toStatus: PaymentStatus.REFUNDED,
              note: `Refund processed successfully (${refundResult.transactionId})`,
            },
          },
        },
      });

      await tx.outboxEvent.create({
        data: {
          id: randomUUID(),
          aggregateId: paymentId,
          eventType: 'payment.refunded',
          topic: 'payment.refunded',
          payload: {
            paymentId,
            referenceId,
            walletTransactionId: refundResult.transactionId,
            userId: payment.userId,
            destinationUserId: payment.destinationUserId ?? null,
            amount: amountStr,
            status: 'REFUNDED',
            refundedAt: refundedAt.toISOString(),
          },
          status: OutboxEventStatus.PENDING,
        },
      });

      await tx.outboxEvent.updateMany({
        where: { id: event.id, lockToken: claim.lockToken },
        data: { status: OutboxEventStatus.SENT, sentAt: new Date(), lockToken: null, lockedUntil: null },
      });
    });

    return { status: 'COMPLETED' };
  } catch (error: any) {
    const status = error.status || (error.statusCode ? Number(error.statusCode) : undefined);
    const code = error.code || 'REFUND_ERROR';
    const message = error.message || 'Refund failed';

    // K13-10: 4xx xác định (INSUFFICIENT_FUNDS, CAPTURE_NOT_FOUND, AMOUNT_MISMATCH, ALREADY_REFUNDED, REFERENCE_ID_REUSED)
    const isDeterministic4xx =
      (status !== undefined && status >= 400 && status < 500) ||
      ['INSUFFICIENT_FUNDS', 'CAPTURE_NOT_FOUND', 'AMOUNT_MISMATCH', 'ALREADY_REFUNDED', 'REFERENCE_ID_REUSED'].includes(code);

    if (isDeterministic4xx) {
      console.error(
        `[Refund Worker] [ALERT] Refund permanently failed for payment ${paymentId}: ${code} - ${message}. Admin attention required.`,
        { paymentId, referenceId, status, code }
      );

      await db.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: paymentId },
          data: {
            status: PaymentStatus.REFUND_FAILED,
            failureCode: code,
            failureReason: message,
            needsAttention: true,
            histories: {
              create: {
                id: randomUUID(),
                fromStatus: payment.status,
                toStatus: PaymentStatus.REFUND_FAILED,
                note: `Refund failed: [${code}] ${message}`,
              },
            },
          },
        });

        await tx.outboxEvent.create({
          data: {
            id: randomUUID(),
            aggregateId: paymentId,
            eventType: 'payment.refund_failed',
            topic: 'payment.refund_failed',
            payload: {
              paymentId,
              referenceId,
              userId: payment.userId,
              destinationUserId: payment.destinationUserId ?? null,
              amount: amountStr,
              failureCode: code,
              failureReason: message,
              failedAt: new Date().toISOString(),
            },
            status: OutboxEventStatus.PENDING,
          },
        });

        await tx.outboxEvent.updateMany({
          where: { id: event.id, lockToken: claim.lockToken },
          data: { status: OutboxEventStatus.FAILED, lockToken: null, lockedUntil: null },
        });
      });

      return { status: 'FAILED' };
    }

    // K13-9: Timeout hoặc 5xx / lỗi mạng không xác định -> Giữ REFUNDING, tăng refundAttempts, đặt backoff
    const nextAttempts = (payment.refundAttempts ?? 0) + 1;
    const delayMs = Math.min(30_000, 1000 * 2 ** Math.min(nextAttempts, 5));
    const nextAttemptAt = new Date(Date.now() + delayMs);

    console.warn(
      `[Refund Worker] Indeterminate error during refund for payment ${paymentId}, keeping REFUNDING for retry (attempt ${nextAttempts}): ${code} - ${message}`,
      { paymentId, referenceId, status, code, nextAttemptAt }
    );

    await db.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          refundAttempts: nextAttempts,
          nextRefundAttemptAt: nextAttemptAt,
        },
      });

      await tx.outboxEvent.updateMany({
        where: { id: event.id, lockToken: claim.lockToken },
        data: {
          status: OutboxEventStatus.PENDING,
          retryCount: { increment: 1 },
          nextRetryAt: nextAttemptAt,
          lockToken: null,
          lockedUntil: null,
        },
      });
    });

    return { status: 'RETRY' };
  }
}

export async function drainRefundOutbox(
  dependencies: {
    prismaClient?: PrismaClient;
    walletClient?: Pick<WalletClient, 'refundCapture' | 'lookupTransaction'>;
  } = {}
): Promise<void> {
  const db = dependencies.prismaClient ?? prisma;
  const claimed = await claimRefundOutboxEvents(db);
  for (const item of claimed) {
    try {
      await processRefundEvent(item, dependencies);
    } catch (err: any) {
      console.error(`[Refund Worker] Unexpected error processing event ${item.id}:`, err);
    }
  }
}

export function startRefundWorker() {
  cron.schedule('*/2 * * * * *', () => {
    void drainRefundOutbox().catch((e) => console.error('[Refund Worker] Drain error:', e));
  });
  console.log('Refund Worker started (runs every 2s)');
}
