import cron from 'node-cron';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export function startOutboxScheduler() {
  // Run every 5 seconds
  cron.schedule('*/5 * * * * *', async () => {
    try {
      const events = await prisma.walletOutboxEvent.findMany({
        where: { publishedAt: null },
        take: 50,
        orderBy: { createdAt: 'asc' }
      });

      if (events.length === 0) return;

      console.log(`[Wallet Outbox] Processing ${events.length} events...`);

      for (const event of events) {
        try {
          const payload = event.payload as any;
          const isAdded = event.topic === 'wallet.balance_added';
          const typeLabel = isAdded ? 'cộng' : 'trừ';
          const amount = payload.amount;
          const balanceAfter = payload.balanceAfter;
          
          let message = `Ví của bạn vừa được ${typeLabel} ${amount} VND. Số dư mới: ${balanceAfter} VND.`;
          
          if (payload.transferType === 'TOPUP') {
            message = `Nạp tiền thành công ${amount} VND. Số dư: ${balanceAfter} VND.`;
          } else if (payload.transferType === 'PAYMENT' && !isAdded) {
            message = `Thanh toán dịch vụ trừ ${amount} VND. Số dư: ${balanceAfter} VND.`;
          } else if (payload.transferType === 'REFUND' && isAdded) {
            message = `Hoàn tiền dịch vụ cộng ${amount} VND. Số dư: ${balanceAfter} VND.`;
          }
          
          const response = await fetch(`${process.env.NOTIFICATION_SERVICE_URL}/api/notifications`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Key': process.env.INTERNAL_KEY || 'f6f2f278e1bddbc7d16c19851cc828ce455015504709b35d232383543d6c1e68'
            },
            body: JSON.stringify({
              userId: payload.userId,
              type: event.topic.toUpperCase().replace('.', '_'), // e.g. WALLET_BALANCE_ADDED
              message: message
            })
          });

          if (response.ok) {
            await prisma.walletOutboxEvent.update({
              where: { id: event.id },
              data: { publishedAt: new Date() }
            });
            console.log(`[Wallet Outbox] Successfully sent notification for event ${event.id}`);
          } else {
            const errText = await response.text();
            console.error(`[Wallet Outbox] Failed to send event ${event.id}:`, errText);
            await prisma.walletOutboxEvent.update({
              where: { id: event.id },
              data: { attempts: { increment: 1 } }
            });
          }
        } catch (error: any) {
          console.error(`[Wallet Outbox] Network error processing event ${event.id}:`, error.message);
          await prisma.walletOutboxEvent.update({
            where: { id: event.id },
            data: { attempts: { increment: 1 } }
          });
        }
      }
    } catch (err: any) {
      console.error(`[Wallet Outbox] Scheduler error:`, err.message);
    }
  });

  console.log('[Scheduler] Wallet Outbox processor started');
}
