import { Module } from '@nestjs/common'
import { InternalApiKeyGuard } from '../common/internal-api-key.guard'
import { PrismaService } from '../prisma/prisma.service'
import { AdminWalletController } from './admin-wallet.controller'
import { WalletController } from './wallet.controller'
import { WalletHoldScheduler } from './wallet-hold.scheduler'
import { WalletService } from './wallet.service'

@Module({
  controllers: [WalletController, AdminWalletController],
  providers: [
    PrismaService,
    InternalApiKeyGuard,
    WalletService,
    WalletHoldScheduler
  ]
})
export class WalletModule {}
