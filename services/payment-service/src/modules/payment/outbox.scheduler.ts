import cron from 'node-cron';
import { OutboxEventStatus } from './enums';
import { MockDbService } from './mock-db.service';

const db = new MockDbService();

export const startOutboxScheduler = () => {
  // Chạy mỗi 5 giây
  cron.schedule('*/5 * * * * *', async () => {
    const events = db.outboxEvents
      .filter(e => e.status === OutboxEventStatus.PENDING)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, 50);

    if (events.length === 0) return;

    console.log(`Found ${events.length} pending outbox events. Processing...`);

    for (const event of events) {
      try {
        console.log(`[EVENT_BUS_MOCK] Publishing event ${event.eventType} to topic ${event.topic} for aggregate ${event.aggregateId}`);
        
        event.status = OutboxEventStatus.SENT;
        event.sentAt = new Date();
      } catch (error) {
        console.error(`Failed to process outbox event ${event.id}:`, error);
      }
    }
  });
};
