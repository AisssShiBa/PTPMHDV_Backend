import { PrismaClient, TopupStatus } from '@prisma/client';
import cron from 'node-cron';

const prisma = new PrismaClient();

export function startTopupExpiryJob() {
  // Chạy mỗi 5 phút
  cron.schedule('*/5 * * * *', async () => {
    try {
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

      const result = await prisma.$executeRaw`
        UPDATE "TopupRequest"
        SET status = 'EXPIRED', "updatedAt" = NOW()
        WHERE status = 'PENDING' AND "createdAt" < ${thirtyMinutesAgo}
      `;
      
      if (result > 0) {
        console.log(`[Job:expireTopups] Expired ${result} topup requests`);
      }
    } catch (error) {
      console.error('[Job:expireTopups] Error:', error);
    }
  });
}
