import cron from 'node-cron';
import { OutboxEventStatus } from '../utils/enums';
import { prisma } from '../utils/prisma';
import { WalletClient } from '../clients/wallet.client';
import { randomUUID } from 'crypto';

export const startPaymentExpiryJob = () => {
  const walletClient = new WalletClient();

  cron.schedule('*/5 * * * *', async () => {
    try {
      const expiredPayments = await prisma.payment.findMany({
        where: {
          status: 'PENDING',
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

          const updated = await prisma.payment.update({
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

          await prisma.outboxEvent.create({
            data: {
              id: randomUUID(),
              aggregateId: payment.id,
              eventType: 'PAYMENT_EXPIRED',
              topic: payment.callbackTopic,
              payload: JSON.parse(JSON.stringify(updated)),
              status: OutboxEventStatus.PENDING,
            }
          });
        } catch (err: any) {
          console.error(`[Scheduler] Failed to process expired payment ${payment.id}:`, err.message);
        }
      }
    } catch (error) {
      console.error('[Payment Expiration Scheduler Error]', error);
    }
  });
  console.log('Payment Expiry Job started (runs every 5 minutes)');
};
