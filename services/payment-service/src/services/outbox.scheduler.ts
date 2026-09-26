import cron from 'node-cron';
import { OutboxEventStatus } from '../utils/enums';
import { prisma } from '../utils/prisma';

import axios from 'axios';

export const startOutboxScheduler = () => {
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
            await axios.post(
              `${process.env.WALLET_SERVICE_URL}/api/wallets/${payment.userId}/release`,
              { referenceId: payment.holdId },
              { headers: { 'x-internal-key': process.env.INTERNAL_KEY || 'default_internal_secret_key_123456' } }
            );
          }

          const updated = await prisma.payment.update({
            where: { id: payment.id },
            data: {
              status: 'EXPIRED',
              histories: {
                create: {
                  id: require('crypto').randomUUID(),
                  fromStatus: 'PENDING',
                  toStatus: 'EXPIRED',
                  note: 'Hold expired by scheduler',
                }
              }
            }
          });

          await prisma.outboxEvent.create({
            data: {
              id: require('crypto').randomUUID(),
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
          const payload = event.payload as any;
          let message = `Giao dịch ${payload.id} đã được xử lý.`;

          if (event.eventType === 'PAYMENT_SUCCESS') {
            message = `Thanh toán thành công ${payload.amount} VND.`;
          } else if (event.eventType === 'PAYMENT_FAILED') {
            message = `Thanh toán thất bại. Lý do: ${payload.failureReason || 'Lỗi hệ thống'}`;
          } else if (event.eventType === 'PAYMENT_REFUNDED') {
            message = `Thanh toán đã được hoàn tiền ${payload.amount} VND.`;
          } else if (event.eventType === 'PAYMENT_CANCELLED') {
            message = `Thanh toán đã bị hủy.`;
          } else {
            // Các type khác hiện tại notification-service chưa hỗ trợ
            // Đánh dấu SENT luôn để bỏ qua
            // Yêu cầu notification update để gọi lại
            await prisma.outboxEvent.update({
              where: { id: event.id },
              data: { status: OutboxEventStatus.SENT, sentAt: new Date() }
            });
            continue;
          }

          // Gọi HTTP POST sang notification-service
          await axios.post(
            `${process.env.NOTIFICATION_SERVICE_URL}/api/notifications`,
            {
              userId: payload.userId,
              type: event.eventType, // PAYMENT_SUCCESS, PAYMENT_FAILED
              message: message
            },
            {
              headers: {
                'X-Internal-Key': process.env.INTERNAL_KEY || 'f6f2f278e1bddbc7d16c19851cc828ce455015504709b35d232383543d6c1e68'
              }
            }
          );

          // Nếu gọi thành công thì update DB
          await prisma.outboxEvent.update({
            where: { id: event.id },
            data: {
              status: OutboxEventStatus.SENT,
              sentAt: new Date(),
            }
          });
        } catch (err: any) {
          console.error(`[Outbox] Lỗi khi gửi event ${event.id} sang notification-service:`, err?.response?.data || err.message);

          if (err?.response?.status >= 400 && err?.response?.status < 500) {
            // Lỗi payload/client error từ notification-service (ví dụ sai type) -> đánh dấu FAILED để không lặp vô tận
            await prisma.outboxEvent.update({
              where: { id: event.id },
              data: { status: OutboxEventStatus.FAILED }
            });
          } else {
            // Lỗi mạng hoặc server error (500) -> Exponential Backoff & DLQ
            const newRetryCount = (event.retryCount || 0) + 1;
            
            if (newRetryCount >= 5) {
              console.error(`[Outbox DLQ] Event ${event.id} vượt quá số lần thử lại (5 lần). Chuyển sang FAILED.`);
              await prisma.outboxEvent.update({
                where: { id: event.id },
                data: { status: OutboxEventStatus.FAILED, retryCount: newRetryCount }
              });
            } else {
              // Exponential backoff: 2s, 4s, 8s, 16s...
              const delaySeconds = Math.pow(2, newRetryCount);
              const nextRetryAt = new Date(Date.now() + delaySeconds * 1000);
              console.log(`[Outbox Backoff] Lùi lại gửi event ${event.id}. Thử lại lần ${newRetryCount} vào ${nextRetryAt.toISOString()}`);
              
              await prisma.outboxEvent.update({
                where: { id: event.id },
                data: { retryCount: newRetryCount, nextRetryAt: nextRetryAt }
              });
            }
          }
        }
      }
    } catch (error) {
      console.error('[Outbox Scheduler Error]', error);
    }
  });
  console.log('Outbox Scheduler started (runs every 5 seconds)');
};
