import { Inject, Injectable, Logger } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import { env } from '../config/env'
import { WalletService } from './wallet.service'

@Injectable()
export class WalletHoldScheduler {
  private readonly logger = new Logger(WalletHoldScheduler.name)

  constructor(@Inject(WalletService) private readonly walletService: WalletService) {}

  @Interval('wallet-expired-hold-release', env.holdSweepIntervalMs)
  async releaseExpiredHolds() {
    try {
      const released = await this.walletService.releaseExpiredHolds()
      if (released > 0) this.logger.log(`Released ${released} expired wallet hold(s)`)
    } catch (error) {
      // Việc chạy lại (retry) ở chu kỳ quét tiếp theo là hoàn toàn an toàn
      // bởi vì quá trình cập nhật trạng thái lệnh hold và trừ số dư đang giữ (held-balance)
      // đều được thực hiện bên trong cùng một database transaction.
      this.logger.error('Could not release expired wallet holds', error)
    }
  }
}
