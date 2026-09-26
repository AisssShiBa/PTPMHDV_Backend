import cron from 'node-cron';
import { WalletService } from './wallet.service';

const walletService = new WalletService();

export const startHoldScheduler = () => {
  cron.schedule('*/10 * * * * *', async () => {
    try {
      const count = await walletService.releaseExpiredHolds();
      if (count > 0) {
        console.log(`[Wallet] Released ${count} expired holds`);
      }
    } catch (error) {
      console.error('[Wallet Hold Scheduler Error]', error);
    }
  });
  console.log('Wallet Hold Scheduler started (runs every 10 seconds)');
};
