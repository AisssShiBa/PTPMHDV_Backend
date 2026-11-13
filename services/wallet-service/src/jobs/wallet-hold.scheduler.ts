import { WalletHoldService } from '../services/wallet-hold.service';
import { LedgerService } from '../services/ledger.service';
import { drainOutbox } from './outbox.scheduler';

const ledgerService = new LedgerService();
const walletHoldService = new WalletHoldService(ledgerService);

// Cron job định kì gửi các khoản tiền tạm giữ (hold) hết hạn cho 
// các dịch vụ khác để xử lý tiếp (ví dụ: trả lại tiền cho người gửi hoặc chuyển sang người nhận tùy theo logic nghiệp vụ)
export const startHoldScheduler = () => {
  const intervalMs = process.env.WALLET_HOLD_EXPIRY_INTERVAL_MS
    ? parseInt(process.env.WALLET_HOLD_EXPIRY_INTERVAL_MS, 10)
    : 10000;

  let isRunning = false;
  const runSweep = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      const result = await walletHoldService.releaseExpiredHolds();
      if (result.released > 0) await drainOutbox();
      if (result.released > 0) {
        console.log(`[Wallet] Released ${result.released} expired holds`);
      }
    } catch (error) {
      console.error('[Wallet Hold Scheduler Error]', error);
    } finally {
      isRunning = false;
    }
  };

  const timer = setInterval(() => void runSweep(), intervalMs);
  console.log(`Wallet Hold Scheduler started (runs every ${intervalMs} ms)`);
  return timer;
};
