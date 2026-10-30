import cron from 'node-cron';
import { PrismaClient } from '@prisma/client';
import { publish } from '../utils/rabbitmq.publisher';
import { env } from '../config/env';
import {
  InvalidWalletOutboxDataError,
  createWalletOutboxDrain,
  shouldPublishLegacyWalletEvent,
  validateWalletOutboxPayload
} from './wallet-event-routing';

const ROUTING_KEY = 'wallet.notification';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL ?? 'http://notification-service:3006';
const INTERNAL_KEY = env.internalApiKey;
const MAX_BATCH_SIZE = 10;
const prisma = new PrismaClient();

async function claimPendingRows(): Promise<string[]> {
  // Wallet has no lease column by ownership constraint: this short lock prevents
  // overlapping claims only while selecting; stable eventId makes cross-process
  // duplicate publication safe for the receiving inbox.
  return prisma.$transaction(async tx => {
    const claimed = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM "WalletOutboxEvent"
      WHERE "publishedAt" IS NULL
      ORDER BY "createdAt" ASC
      LIMIT ${MAX_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    `;
    return claimed.map(row => row.id);
  }, { maxWait: 5000, timeout: 15_000 });
}

async function markPublished(id: string): Promise<void> {
  await prisma.walletOutboxEvent.update({
    where: { id },
    data: { publishedAt: new Date() }
  });
}

async function processWalletOutboxRow(id: string): Promise<void> {
  const event = await prisma.walletOutboxEvent.findFirst({
    where: { id, publishedAt: null }
  });
  if (!event) return;

  try {
    const payload = event.payload as Record<string, unknown>;
    validateWalletOutboxPayload(event.topic, payload);
    if (!shouldPublishLegacyWalletEvent(payload)) {
      await markPublished(event.id)
      return;
    }

    const isAdded = event.topic === 'wallet.balance_added';
    const amount = String(payload.amount);
    const balanceAfter = String(payload.balanceAfter);
    const transferType = String(payload.transferType);
    const userId = String(payload.userId);
    let message = `Ví của bạn vừa được ${isAdded ? 'cộng' : 'trừ'} ${amount} VND. Số dư mới: ${balanceAfter} VND.`;

    if (transferType === 'TOPUP') {
      message = `Nạp tiền thành công ${amount} VND. Số dư: ${balanceAfter} VND.`;
    } else if (transferType === 'PAYMENT' && !isAdded) {
      message = `Thanh toán dịch vụ trừ ${amount} VND. Số dư: ${balanceAfter} VND.`;
    } else if (transferType === 'REFUND' && isAdded) {
      message = `Hoàn tiền dịch vụ cộng ${amount} VND. Số dư: ${balanceAfter} VND.`;
    }

    let type = event.topic.toUpperCase().replace('.', '_');
    if (type === 'WALLET_BALANCE_ADDED') type = 'WALLET_CREDITED';
    if (type === 'WALLET_BALANCE_DEDUCTED') type = 'WALLET_DEBITED';

    const mqPayload = { eventId: String(event.id), userId, type, message };
    const sent = await publish('wallet.events', ROUTING_KEY, mqPayload, { messageId: String(event.id) })
      .catch(() => false);

    if (!sent) {
      const response = await fetch(`${NOTIFICATION_SERVICE_URL}/api/notifications`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': INTERNAL_KEY
        },
        body: JSON.stringify(mqPayload),
        signal: AbortSignal.timeout(8000)
      });

      if (!response.ok) {
        const error = new Error(`Notification fallback returned HTTP ${response.status}`)
        Object.assign(error, { status: response.status })
        throw error
      }
    }

    await markPublished(event.id);
  } catch (error: unknown) {
    if (error instanceof InvalidWalletOutboxDataError) {
      console.error('[Wallet Outbox] Invalid event data; marking row complete', {
        eventId: event.id,
        topic: event.topic
      });
      await markPublished(event.id);
      return;
    }

    const status = (error as { status?: number }).status;
    const attempts = event.attempts + 1;
    if (status !== undefined && status >= 400 && status < 500) {
      console.error('[Wallet Outbox] Permanent notification rejection', {
        eventId: event.id,
        topic: event.topic,
        status
      });
      await markPublished(event.id);
      return;
    }

    console.error('[Wallet Outbox] Delivery failed; event remains pending', {
      eventId: event.id,
      topic: event.topic,
      error: error instanceof Error ? error.message : 'unknown error'
    });
    await prisma.walletOutboxEvent.update({
      where: { id: event.id },
      data: { attempts }
    });
  }
}

async function runOutboxDrain(): Promise<void> {
  const claimedIds = await claimPendingRows();
  for (const id of claimedIds) {
    await processWalletOutboxRow(id);
  }
}

export const drainOutbox = createWalletOutboxDrain(runOutboxDrain);

export function startOutboxScheduler(): void {
  cron.schedule('*/1 * * * * *', () => {
    void drainOutbox().catch(error => {
      console.error('[Wallet Outbox] Scheduler error:', error instanceof Error ? error.message : 'unknown error');
    });
  });
  console.log('[Scheduler] Wallet Outbox processor started (1-second fallback interval)');
}
