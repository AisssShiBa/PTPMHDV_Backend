import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OutboxEventStatus } from './enums';
import { MockDbService } from './mock-db.service';

@Injectable()
export class OutboxScheduler {
  private readonly logger = new Logger(OutboxScheduler.name);

  constructor(@Inject(MockDbService) private readonly db: MockDbService) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async processOutboxEvents() {
    const events = this.db.outboxEvents
      .filter(e => e.status === OutboxEventStatus.PENDING)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, 50);

    if (events.length === 0) return;

    this.logger.log(`Found ${events.length} pending outbox events. Processing...`);

    for (const event of events) {
      try {
        this.logger.log(`[EVENT_BUS_MOCK] Publishing event ${event.eventType} to topic ${event.topic} for aggregate ${event.aggregateId}`);
        
        event.status = OutboxEventStatus.SENT;
        event.sentAt = new Date();
      } catch (error) {
        this.logger.error(`Failed to process outbox event ${event.id}:`, error);
      }
    }
  }
}
