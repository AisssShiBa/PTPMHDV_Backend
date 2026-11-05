import { P2pService } from '../services/p2p.service';
import cron from 'node-cron';
import { OutboxEventStatus, PaymentStatus } from '../utils/enums';
import { prisma } from '../utils/prisma';
import { WalletClient } from '../clients/wallet.client';
import { randomUUID } from 'crypto';
import { drainOutbox } from './outbox.job';

export interface SweepExpiredPaymentsOptions {
  now?: Date;
  limit?: number;
  walletClient?: WalletClient;
  paymentId?: string;
}

export interface SweepExpiredPaymentsResult {
  scanned: number;
  expired: number;
  skipped: number;
  errors: number;
}

export async function sweepExpiredPayments(
  options?: SweepExpiredPaymentsOptions
): Promise<SweepExpiredPaymentsResult> {
  const now = options?.now || new Date();
  const limit = options?.limit || 50;
  const wallet = options?.walletClient || new WalletClient();

  const where: any = options?.paymentId
    ? { id: options.paymentId }
    : {
        status: PaymentStatus.PENDING,
        holdExpiresAt: { lte: now }
      };

  const expiredPayments = await prisma.payment.findMany({
    where,
    take: limit,
  });

  const scanned = expiredPayments.length;
  let expired = 0;
  let skipped = 0;
  let errors = 0;

  for (const payment of expiredPayments) {
    console.log(`[Scheduler] Payment ${payment.id} hold expired. Releasing...`);
    try {
      if (payment.holdId) {
        try {
          await wallet.releaseHold(payment.userId, payment.holdId);
        } catch (releaseErr: any) {
          // Nếu hold đã được ví nhả hoặc trả lỗi lũy đẳng (HOLD_EXPIRED / HOLD_NOT_CAPTURABLE)
          const isAlreadyHandled =
            releaseErr?.code === 'HOLD_EXPIRED' ||
            releaseErr?.code === 'HOLD_NOT_CAPTURABLE' ||
            releaseErr?.code === 'HOLD_ALREADY_RELEASED';
          if (!isAlreadyHandled) {
            throw releaseErr;
          }
        }
      }

      // Cập nhật có điều kiện: chỉ đổi PENDING -> EXPIRED
      const txResult = await prisma.$transaction(async tx => {
        const updateResult = await tx.payment.updateMany({
          where: {
            id: payment.id,
            status: PaymentStatus.PENDING
          },
          data: {
            status: PaymentStatus.EXPIRED,
            workflow: 'IDLE'
          }
        });

        // Chỉ khi update thành công (đang là PENDING) mới ghi history và outbox event đúng 1 lần
        if (updateResult.count === 1) {
          await tx.paymentHistory.create({
            data: {
              id: randomUUID(),
              paymentId: payment.id,
              fromStatus: PaymentStatus.PENDING,
              toStatus: PaymentStatus.EXPIRED,
              note: 'Hold expired by scheduler',
            }
          });

          const eventId = randomUUID();
          await tx.outboxEvent.create({
            data: {
              id: eventId,
              aggregateId: payment.id,
              eventType: 'payment.expired',
              topic: payment.callbackTopic || 'finvault.events',
              payload: {
                eventId,
                eventType: 'payment.expired',
                eventVersion: 1,
                occurredAt: new Date().toISOString(),
                paymentId: payment.id,
                senderId: payment.userId,
                id: payment.id,
                userId: payment.userId,
                status: PaymentStatus.EXPIRED,
                type: payment.type,
                amount: payment.amount.toString(),
                data: {
                  paymentId: payment.id,
                  senderId: payment.userId
                }
              },
              status: OutboxEventStatus.PENDING,
            }
          });

          return { expired: true };
        }

        // Đã là EXPIRED hoặc tiến trình khác xử lý -> idempotent, không tạo outbox lần 2
        return { expired: false };
      });

      if (txResult.expired) {
        expired++;
        void drainOutbox().catch(error => {
          console.error('[Payment Outbox] Post-expiry drain failed', error instanceof Error ? error.message : 'unknown error');
        });
      } else {
        skipped++;
      }
    } catch (err: any) {
      errors++;
      console.error(`[Scheduler] Failed to process expired payment ${payment.id}:`, err?.message || String(err));
    }
  }

  return { scanned, expired, skipped, errors };
}

export const startPaymentExpiryJob = () => {
  const walletClient = new WalletClient();
  const p2p = new P2pService(walletClient);
  let recovering = false;
  const recover = async () => {
    if (recovering) return;
    recovering = true;
    try { await p2p.recover(); await drainOutbox(); }
    catch { console.error('[Payment] Recovery will retry'); }
    finally { recovering = false; }
  };
  setInterval(() => void recover(), 2000);
  void recover();

  cron.schedule('*/30 * * * * *', async () => {
    try {
      await sweepExpiredPayments({ walletClient });
    } catch (error) {
      console.error('[Payment Expiration Scheduler Error]', error);
    }
  });
  console.log('Payment Expiry Job started (runs every 30 seconds)');
};
