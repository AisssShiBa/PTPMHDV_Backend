import cron from 'node-cron';
import { OutboxEventStatus } from '../utils/enums';
import { prisma } from '../utils/prisma';
import { NotificationClient } from '../clients/notification.client';
import { publish } from '../utils/rabbitmq.publisher';

/**
 * Type validation (Bước 4):
 * eventType từ payment outbox phải thuộc whitelist của notification-service:
 *   PAYMENT_SUCCESS    ✅
 *   PAYMENT_FAILED     ✅
 *   PAYMENT_REFUNDED   ✅
 *   PAYMENT_CANCELLED  ✅
 *   PAYMENT_EXPIRED    ❌ — KHÔNG có trong whitelist notification-service
 *                         → xử lý như cũ: mark SENT ngay, skip gửi
 *
 * Routing key: 'payment.notification' (binding '#' của consumer khớp tất cả)
 */
const ROUTING_KEY = 'payment.notification';

export const startOutboxJob = () => {
  const notificationClient = new NotificationClient();

  cron.schedule('*/5 * * * * *', async () => {
    try {
      const pendingEvents = await prisma.outboxEvent.findMany({
        where: {
          status: OutboxEventStatus.PENDING,
          OR: [
            { nextRetryAt: null },
            { nextRetryAt: { lte: new Date() } }
          ]
        },
        take: 50,
      });

      for (const event of pendingEvents) {
        console.log(`[Outbox] Processing event ${event.id} - ${event.topic}`);

        try {
          const payload = event.payload as Record<string, unknown>;
          let message = `Giao dịch ${String(payload.id ?? '')} đã được xử lý.`;

          if (event.eventType === 'PAYMENT_SUCCESS') {
            message = `Thanh toán thành công ${String(payload.amount ?? '')} VND.`;
          } else if (event.eventType === 'PAYMENT_FAILED') {
            message = `Thanh toán thất bại. Lý do: ${String(payload.failureReason ?? 'Lỗi hệ thống')}`;
          } else if (event.eventType === 'PAYMENT_REFUNDED') {
            message = `Thanh toán đã được hoàn tiền ${String(payload.amount ?? '')} VND.`;
          } else if (event.eventType === 'PAYMENT_CANCELLED') {
            message = `Thanh toán đã bị hủy.`;
          } else {
            // PAYMENT_EXPIRED và các type khác không có trong whitelist notification-service
            // → đánh dấu SENT ngay, không gửi
            await prisma.outboxEvent.update({
              where: { id: event.id },
              data: { status: OutboxEventStatus.SENT, sentAt: new Date() }
            });
            continue;
          }

          const userId = String(payload.userId ?? '');
          const mqPayload = { userId, type: event.eventType, message };

          // --- Thử RabbitMQ trước ---
          let sent = false;
          try {
            sent = await publish('payment.events', ROUTING_KEY, mqPayload, { messageId: event.id });
          } catch {
            sent = false;
          }

          if (sent) {
            // RabbitMQ đã confirm — đánh dấu thành công
            await prisma.outboxEvent.update({
              where: { id: event.id },
              data: { status: OutboxEventStatus.SENT, sentAt: new Date() }
            });
            console.log(`[Outbox] Event ${event.id} sent via RabbitMQ.`);
            continue;
          }

          // --- Fallback: HTTP POST sang notification-service ---
          console.warn(`[Outbox] RabbitMQ unavailable for event ${event.id}, falling back to HTTP.`);
          await notificationClient.send(userId, event.eventType, message);

          await prisma.outboxEvent.update({
            where: { id: event.id },
            data: { status: OutboxEventStatus.SENT, sentAt: new Date() }
          });
          console.log(`[Outbox] Event ${event.id} sent via HTTP fallback.`);

        } catch (err: unknown) {
          const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string };
          console.error(
            `[Outbox] Lỗi khi gửi event ${event.id}:`,
            axiosErr?.response?.data ?? axiosErr?.message
          );

          const httpStatus = axiosErr?.response?.status;

          if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
            // Lỗi 4xx từ notification-service (payload sai, type không hợp lệ)
            // → đánh dấu FAILED, không retry (chỉ áp dụng cho nhánh HTTP fallback)
            await prisma.outboxEvent.update({
              where: { id: event.id },
              data: { status: OutboxEventStatus.FAILED }
            });
          } else {
            // Lỗi mạng, 5xx, hoặc lỗi publish RabbitMQ → Exponential Backoff & DLQ
            const newRetryCount = (event.retryCount ?? 0) + 1;

            if (newRetryCount >= 5) {
              console.error(`[Outbox DLQ] Event ${event.id} vượt quá số lần thử lại (5 lần). Chuyển sang FAILED.`);
              await prisma.outboxEvent.update({
                where: { id: event.id },
                data: { status: OutboxEventStatus.FAILED, retryCount: newRetryCount }
              });
            } else {
              const delaySeconds = Math.pow(2, newRetryCount);
              const nextRetryAt = new Date(Date.now() + delaySeconds * 1000);
              console.log(`[Outbox Backoff] Event ${event.id}. Thử lại lần ${newRetryCount} vào ${nextRetryAt.toISOString()}`);

              await prisma.outboxEvent.update({
                where: { id: event.id },
                data: { retryCount: newRetryCount, nextRetryAt }
              });
            }
          }
        }
      }
    } catch (error) {
      console.error('[Outbox Scheduler Error]', error);
    }
  });

  console.log('Outbox Job started (runs every 5 seconds)');
};
