import { P2pService } from '../services/p2p.service';
import cron from 'node-cron';
import { OutboxEventStatus } from '../utils/enums';
import { prisma } from '../utils/prisma';
import { WalletClient } from '../clients/wallet.client';
import { randomUUID } from 'crypto';
import { drainOutbox } from './outbox.job';

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
      const expiredPayments = await prisma.payment.findMany({
        where: {
          status: 'PENDING',
          type: { not: 'WALLET_TRANSFER' },
          holdExpiresAt: { lt: new Date() }
        },
        take: 50,
      });

      for (const payment of expiredPayments) {
        console.log(`[Scheduler] Payment ${payment.id} hold expired. Releasing...`);
        try {
          if (payment.holdId) {
            await walletClient.releaseHold(payment.userId, payment.holdId);
          }

          await prisma.$transaction(async tx => {
            const updated = await tx.payment.update({
              where: { id: payment.id },
              data: {
                status: 'EXPIRED',
                histories: {
                  create: {
                    id: randomUUID(),
                    fromStatus: 'PENDING',
                    toStatus: 'EXPIRED',
                    note: 'Hold expired by scheduler',
                  }
                }
              }
            });

            await tx.outboxEvent.create({
              data: {
                id: randomUUID(),
                aggregateId: payment.id,
                eventType: 'PAYMENT_EXPIRED',
                topic: payment.callbackTopic,
                payload: JSON.parse(JSON.stringify(updated)),
                status: OutboxEventStatus.PENDING,
              }
            });
          });
          void drainOutbox().catch(error => {
            console.error('[Payment Outbox] Post-expiry drain failed', error instanceof Error ? error.message : 'unknown error');
          });
        } catch (err: any) {
          console.error(`[Scheduler] Failed to process expired payment ${payment.id}:`, err.message);
        }
      }
    } catch (error) {
      console.error('[Payment Expiration Scheduler Error]', error);
    }
  });
  console.log('Payment Expiry Job started (runs every 30 seconds)');
};
