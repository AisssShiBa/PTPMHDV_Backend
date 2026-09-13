import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { WalletModule } from './wallet/wallet.module'

@Module({
  imports: [ScheduleModule.forRoot(), WalletModule]
})
export class AppModule {}
