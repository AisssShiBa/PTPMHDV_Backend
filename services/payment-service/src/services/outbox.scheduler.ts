import cron from 'node-cron';
import { OutboxEventStatus } from '../utils/enums';
import { prisma } from '../utils/prisma';

import axios from 'axios';

export const startOutboxScheduler = () => {
  cron.schedule('*/5 * * * * *', async () => {
    try {
      const pendingEvents = await prisma.outboxEvent.findMany({
        where: { status: OutboxEventStatus.PENDING },
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
          } else {
            // Các type khác như PAYMENT_REFUNDED hiện tại notification-service chưa hỗ trợ
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
          }
        }
      }
    } catch (error) {
      console.error('[Outbox Scheduler Error]', error);
    }
  });
  console.log('Outbox Scheduler started (runs every 5 seconds)');
};
