import cron from 'node-cron';
import { TopupService } from '../../services/topup.service';

// A paid but still-PROCESSING topup means the wallet outcome was never
// confirmed (timeout, 5xx, crash between credit and status update). This worker
// re-drives those rows with the same referenceId (topup.code), so wallet
// idempotency prevents a second credit. Anything less certain must not be
// touched here: only rows VNPAY already reported as paid are eligible.
export function startRecoverTopupsJob() {
  const service = new TopupService();
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await service.recoverStuckTopups();
    } catch (error) {
      console.error('[Job:recoverTopups] Recovery pass failed', error instanceof Error ? error.message : 'unknown error');
    } finally {
      running = false;
    }
  };

  cron.schedule('* * * * *', () => void run());
  console.log('Topup recovery job started (runs every minute)');
}
