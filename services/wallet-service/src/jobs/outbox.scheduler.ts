import cron from 'node-cron';
import { PrismaClient } from '@prisma/client';
import { publish } from '../utils/rabbitmq.publisher';

/**
 * Type validation (Bước 4):
 * Type suy ra từ topic + transferType (wallet outbox):
 *   wallet.balance_added   → WALLET_CREDITED  ✅
 *   wallet.balance_deducted → WALLET_DEBITED  ✅
 *
 * Routing key: 'wallet.notification' (binding '#' của consumer khớp tất cả)
 */
const ROUTING_KEY = 'wallet.notification';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL ?? 'http://notification-service:3006';
const INTERNAL_KEY = process.env.INTERNAL_KEY ?? 'f6f2f278e1bddbc7d16c19851cc828ce455015504709b35d232383543d6c1e68';

const prisma = new PrismaClient();

export function startOutboxScheduler() {
  // Run every 5 seconds
  cron.schedule('*/5 * * * * *', async () => {
    try {
      const events = await prisma.walletOutboxEvent.findMany({
        where: { publishedAt: null },
        take: 50,
        orderBy: { createdAt: 'asc' }
      });

      if (events.length === 0) return;

      console.log(`[Wallet Outbox] Processing ${events.length} events...`);

      for (const event of events) {
        try {
          const payload = event.payload as Record<string, unknown>;
          const isAdded = event.topic === 'wallet.balance_added';
          const typeLabel = isAdded ? 'cộng' : 'trừ';
          const amount = String(payload.amount ?? '');
          const balanceAfter = String(payload.balanceAfter ?? '');
          const transferType = String(payload.transferType ?? '');
          const userId = String(payload.userId ?? '');

          // --- Build message tiếng Việt ---
          let message = `Ví của bạn vừa được ${typeLabel} ${amount} VND. Số dư mới: ${balanceAfter} VND.`;

          if (transferType === 'TOPUP') {
            message = `Nạp tiền thành công ${amount} VND. Số dư: ${balanceAfter} VND.`;
          } else if (transferType === 'PAYMENT' && !isAdded) {
            message = `Thanh toán dịch vụ trừ ${amount} VND. Số dư: ${balanceAfter} VND.`;
          } else if (transferType === 'REFUND' && isAdded) {
            message = `Hoàn tiền dịch vụ cộng ${amount} VND. Số dư: ${balanceAfter} VND.`;
          }

          // --- Map topic → NotificationType (phải khớp whitelist notification-service) ---
          let type = event.topic.toUpperCase().replace('.', '_');
          if (type === 'WALLET_BALANCE_ADDED') type = 'WALLET_CREDITED';
          if (type === 'WALLET_BALANCE_DEDUCTED') type = 'WALLET_DEBITED';

          const mqPayload = { userId, type, message };
          const messageId = String(event.id);

          // --- Thử RabbitMQ trước ---
          let sent = false;
          try {
            sent = await publish('wallet.events', ROUTING_KEY, mqPayload, { messageId });
          } catch {
            sent = false;
          }

          if (sent) {
            await prisma.walletOutboxEvent.update({
              where: { id: event.id },
              data: { publishedAt: new Date() }
            });
            console.log(`[Wallet Outbox] Event ${event.id} sent via RabbitMQ.`);
            continue;
          }

          // --- Fallback: HTTP POST sang notification-service ---
          console.warn(`[Wallet Outbox] RabbitMQ unavailable for event ${event.id}, falling back to HTTP.`);

          const response = await fetch(`${NOTIFICATION_SERVICE_URL}/api/notifications`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Key': INTERNAL_KEY
            },
            body: JSON.stringify({ userId, type, message })
          });

          if (response.ok) {
            await prisma.walletOutboxEvent.update({
              where: { id: event.id },
              data: { publishedAt: new Date() }
            });
            console.log(`[Wallet Outbox] Event ${event.id} sent via HTTP fallback.`);
          } else {
            const errText = await response.text();
            console.error(`[Wallet Outbox] HTTP fallback failed for event ${event.id}:`, errText);
            await prisma.walletOutboxEvent.update({
              where: { id: event.id },
              data: { attempts: { increment: 1 } }
            });
          }

        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[Wallet Outbox] Error processing event ${event.id}:`, message);
          await prisma.walletOutboxEvent.update({
            where: { id: event.id },
            data: { attempts: { increment: 1 } }
          });
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Wallet Outbox] Scheduler error:`, message);
    }
  });

  console.log('[Scheduler] Wallet Outbox processor started');
}
