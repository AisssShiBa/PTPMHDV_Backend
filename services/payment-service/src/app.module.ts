import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PaymentModule } from './modules/payment/payment.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PaymentModule
  ],
})
export class AppModule {}
