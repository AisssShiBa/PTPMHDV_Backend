import cron from 'node-cron';
import { CashOutService } from '../services/cashout.service';

// Re-drives cash-outs whose hold/payout/capture step was interrupted. Every
// step is idempotent by holdRef/providerRef, so a repeated pass cannot move
// money twice; the lease inside drive() keeps two instances from deciding
// different terminal states for the same row.
export function startRecoverCashoutsJob() {
  const service = new CashOutService();
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const scanned = await service.recover();
      // Only the scheduled pass proves recovery on its own; an explicit test
      // call logs nothing, so this line cannot be satisfied by a manual retry.
      if (scanned > 0) console.log('[Job:recoverCashouts] scanned=' + scanned);
    } catch (error) {
      console.error('[Job:recoverCashouts] Recovery pass failed', error instanceof Error ? error.message : 'unknown error');
    } finally {
      running = false;
    }
  };

  cron.schedule('* * * * *', () => void run());
  console.log('Cash-out recovery job started (runs every minute)');
}
