import cron from 'node-cron';
import { WalletService } from './wallet.service';

const walletService = new WalletService();

export const startHoldScheduler = () => {
  // Chạy mỗi 1 phút thay vì theo mili giây cho đơn giản
  cron.schedule('* * * * *', async () => {
    try {
      const released = await walletService.releaseExpiredHolds();
      if (released > 0) console.log(`Released ${released} expired wallet hold(s)`);
    } catch (error) {
      console.error('Could not release expired wallet holds', error);
    }
  });
};
