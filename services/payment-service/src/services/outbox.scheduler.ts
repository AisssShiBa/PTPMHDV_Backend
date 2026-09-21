import cron from 'node-cron';
import { OutboxEventStatus } from '../utils/enums';
import { prisma } from '../utils/prisma';

export const startOutboxScheduler = () => {
  cron.schedule('*/5 * * * * *', async () => {
    try {
      const pendingEvents = await prisma.outboxEvent.findMany({
        where: { status: OutboxEventStatus.PENDING },
        take: 50,
      });

      for (const event of pendingEvents) {
        console.log(`[Outbox] Processing event ${event.id} - ${event.topic}`);
        // TODO: Gửi Message Broker (Kafka/RabbitMQ) hoặc Axios gọi webhook
        // Giả lập gửi thành công:
        
        await prisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            status: OutboxEventStatus.SENT,
            sentAt: new Date(),
          }
        });
      }
    } catch (error) {
      console.error('[Outbox Scheduler Error]', error);
    }
  });
  console.log('Outbox Scheduler started (runs every 5 seconds)');
};
