import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { OutboxScheduler } from './outbox.scheduler';

import { MockDbService } from './mock-db.service';

@Module({
  controllers: [PaymentController],
  providers: [PaymentService, OutboxScheduler, MockDbService],
  exports: [PaymentService]
})
export class PaymentModule {}
