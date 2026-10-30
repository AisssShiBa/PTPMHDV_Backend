import cron from 'node-cron';
import { Prisma, PrismaClient } from '@prisma/client';
import { createSingleFlight } from 'finvault-events';
import { publish } from '../utils/rabbitmq.publisher';
import { env } from '../config/env';
import { shouldPublishLegacyWalletEvent } from './wallet-event-routing';

const ROUTING_KEY = 'wallet.notification';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL ?? 'http://notification-service:3006';
const INTERNAL_KEY = env.internalApiKey;
const prisma = new PrismaClient();

const runOutboxDrain = async (): Promise<void> => {
  await prisma.$transaction(async tx => {
    const claimed = await tx.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM "WalletOutboxEvent"
      WHERE "publishedAt" IS NULL
      ORDER BY "createdAt" ASC
      LIMIT 50
      FOR UPDATE SKIP LOCKED
    `;

    for (const { id } of claimed) {
      const event = await tx.walletOutboxEvent.findUnique({ where: { id } });
      if (!event) continue;

      try {
        const payload = event.payload as Record<string, unknown>;
        if (!shouldPublishLegacyWalletEvent(payload)) {
          await tx.walletOutboxEvent.update({
            where: { id: event.id },
            data: { publishedAt: new Date() }
          });
          continue;
        }

        const isAdded = event.topic === 'wallet.balance_added';
        const typeLabel = isAdded ? 'cộng' : 'trừ';
        const amount = String(payload.amount ?? '');
        const balanceAfter = String(payload.balanceAfter ?? '');
        const transferType = String(payload.transferType ?? '');
        const userId = String(payload.userId ?? '');
        let message = `Ví của bạn vừa được ${typeLabel} ${amount} VND. Số dư mới: ${balanceAfter} VND.`;

        if (transferType === 'TOPUP') {
          message = `Nạp tiền thành công ${amount} VND. Số dư: ${balanceAfter} VND.`;
        } else if (transferType === 'PAYMENT' && !isAdded) {
          message = `Thanh toán dịch vụ trừ ${amount} VND. Số dư: ${balanceAfter} VND.`;
        } else if (transferType === 'REFUND' && isAdded) {
          message = `Hoàn tiền dịch vụ cộng ${amount} VND. Số dư: ${balanceAfter} VND.`;
        }

        let type = event.topic.toUpperCase().replace('.', '_');
        if (type === 'WALLET_BALANCE_ADDED') type = 'WALLET_CREDITED';
        if (type === 'WALLET_BALANCE_DEDUCTED') type = 'WALLET_DEBITED';

        const mqPayload = { eventId: String(event.id), userId, type, message };
        const sent = await publish('wallet.events', ROUTING_KEY, mqPayload, { messageId: String(event.id) })
          .catch(() => false);

        if (sent) {
          await tx.walletOutboxEvent.update({
            where: { id: event.id },
            data: { publishedAt: new Date() }
          });
          continue;
        }

        const response = await fetch(`${NOTIFICATION_SERVICE_URL}/api/notifications`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Key': INTERNAL_KEY
          },
          body: JSON.stringify(mqPayload)
        });

        if (response.ok) {
          await tx.walletOutboxEvent.update({
            where: { id: event.id },
            data: { publishedAt: new Date() }
          });
        } else {
          console.error(`[Wallet Outbox] HTTP fallback failed for event ${event.id}: status ${response.status}`);
          await tx.walletOutboxEvent.update({
            where: { id: event.id },
            data: { attempts: { increment: 1 } }
          });
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Wallet Outbox] Error processing event ${event.id}:`, message);
        await tx.walletOutboxEvent.update({
          where: { id: event.id },
          data: { attempts: { increment: 1 } }
        });
      }
    }
  }, { maxWait: 15000, timeout: 60000 });
};

export const drainOutbox = createSingleFlight(runOutboxDrain);

export function startOutboxScheduler(): void {
  cron.schedule('*/1 * * * * *', () => {
    void drainOutbox().catch(error => {
      console.error('[Wallet Outbox] Scheduler error:', error instanceof Error ? error.message : 'unknown error');
    });
  });
  console.log('[Scheduler] Wallet Outbox processor started (1-second fallback interval)');
}
