import { OwnerType, PrismaClient } from '@prisma/client';
import amqplib from 'amqplib';

const prisma = new PrismaClient();

export async function updateWalletKycTier(authUserId: string, kycTier: number): Promise<number> {
  const result = await prisma.wallet.updateMany({
    where: {
      userId: authUserId,
      ownerType: OwnerType.USER,
    },
    data: {
      kycTier,
    },
  });
  return result.count;
}

// Khời tạo consumer để lắng nghe sự kiện user.kyc_updated từ user-service
// B1: Khởi tạo connection và channel tới RabbitMQ.
// B2: Khai báo exchange và queue.
// B3: Bind queue tới exchange.
// B4: Consume message.
export async function startKycConsumer(): Promise<void> {
  const rabbitmqUrl = process.env.RABBITMQ_URL;
  if (!rabbitmqUrl) {
    console.log('[KycConsumer] RABBITMQ_URL not configured. Consumer skipped.');
    return;
  }

  const exchange = process.env.EVENT_EXCHANGE || 'finvault.events';
  const queue = 'wallet-service.kyc-updated';

  try {
    const connection = await amqplib.connect(rabbitmqUrl);
    const channel = await connection.createChannel();

    await channel.assertExchange(exchange, 'topic', { durable: true });
    await channel.assertQueue(queue, { durable: true });
    await channel.bindQueue(queue, exchange, 'user.kyc_updated');

    console.log(`[KycConsumer] Listening for user.kyc_updated on ${queue}`);

    await channel.consume(queue, async (msg) => {
      if (!msg) return;
      try {
        const payload = JSON.parse(msg.content.toString());
        // Finvault event envelope or direct payload
        const data = payload.data || payload;
        const { authUserId, kycTier } = data;

        if (authUserId && typeof kycTier === 'number') {
          const updated = await updateWalletKycTier(authUserId, kycTier);
          console.log(`[KycConsumer] Updated kycTier=${kycTier} for user=${authUserId} (${updated} wallets)`);
        }

        channel.ack(msg);
      } catch (err) {
        console.error('[KycConsumer] Error processing message:', err);
        // Nack without requeue or send to DLQ if malformed
        channel.nack(msg, false, false);
      }
    });
  } catch (error) {
    console.error('[KycConsumer] Failed to connect to RabbitMQ:', error);
  }
}
