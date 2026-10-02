import cron from 'node-cron';
import { WalletHoldService } from '../services/wallet-hold.service';
import { LedgerService } from '../services/ledger.service';

const ledgerService = new LedgerService();
const walletHoldService = new WalletHoldService(ledgerService);

export const startHoldScheduler = () => {
  cron.schedule('*/10 * * * * *', async () => {
    try {
      const count = await walletHoldService.releaseExpiredHolds();
      if (count > 0) {
        console.log(`[Wallet] Released ${count} expired holds`);
      }
    } catch (error) {
      console.error('[Wallet Hold Scheduler Error]', error);
    }
  });
  console.log('Wallet Hold Scheduler started (runs every 10 seconds)');
};
