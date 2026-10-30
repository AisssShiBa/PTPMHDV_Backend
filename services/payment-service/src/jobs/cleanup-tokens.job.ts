import cron from 'node-cron';
import { prisma } from '../utils/prisma';

export const startTokenCleanupJob = () => {
  // Dọn rác các token đã sử dụng quá 5 phút (token TTL thực tế chỉ 60 giây)
  cron.schedule('*/10 * * * *', async () => {
    try {
      const threshold = new Date(Date.now() - 5 * 60 * 1000);
      const result = await prisma.usedTransactionToken.deleteMany({
        where: {
          usedAt: { lt: threshold }
        }
      });
      if (result.count > 0) {
        console.log(`[Scheduler] Cleaned up ${result.count} expired transaction tokens`);
      }
    } catch (err) {
      console.error('[Scheduler] Failed to clean up used transaction tokens:', err);
    }
  });
};

