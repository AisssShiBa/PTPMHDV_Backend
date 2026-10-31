import { OwnerType, Prisma, PrismaClient } from '@prisma/client';
import { createConsumer, type EventConsumer, type InboxAdapter, type InboxResult } from 'finvault-events';
const prisma = new PrismaClient();
let consumer: EventConsumer | undefined;
let retry: NodeJS.Timeout | undefined;
let stopped = false;

export function walletInbox(database = prisma): InboxAdapter {
  return {
    async runOnce<T>(args: { eventId: string; payloadHash: string }, handler: (tx: unknown) => Promise<T>): Promise<InboxResult<T>> {
      return database.$transaction(async tx => {
        const inserted = await tx.$executeRaw`INSERT INTO "WalletInbox" ("eventId", "payloadHash")
          VALUES (${args.eventId}, ${args.payloadHash}) ON CONFLICT ("eventId") DO NOTHING`;
        if (!inserted) {
          const previous = await tx.walletInbox.findUniqueOrThrow({ where: { eventId: args.eventId } });
          return previous.payloadHash === args.payloadHash ? { status: 'duplicate' } : { status: 'conflict' };
        }
        return { status: 'processed', result: await handler(tx) };
      });
    }
  };
}

export async function startKycConsumer(): Promise<void> {
  if (stopped) return;
  const url = process.env.RABBITMQ_URL;
  if (!url) throw new Error('RABBITMQ_URL is required for Wallet provisioning');
  consumer = createConsumer({ url, queue: 'wallet-service.kyc-updated',
    exchange: process.env.EVENT_EXCHANGE || 'finvault.events',
    bindings: ['user.registered', 'user.kyc_updated', 'merchant.status_updated'],
    inbox: walletInbox(), handlers: {
      'user.registered': async (event, context) => {
        const tx = context.tx as Prisma.TransactionClient;
        const data = event.data as { authUserId: string };
        await tx.wallet.upsert({ where: { userId_ownerType: { userId: data.authUserId, ownerType: OwnerType.USER } },
          create: { userId: data.authUserId, ownerType: OwnerType.USER }, update: {} });
      },
      'user.kyc_updated': async (event, context) => {
        const tx = context.tx as Prisma.TransactionClient;
        const data = event.data as { authUserId: string; kycTier: number };
        await tx.wallet.upsert({ where: { userId_ownerType: { userId: data.authUserId, ownerType: OwnerType.USER } },
          create: { userId: data.authUserId, ownerType: OwnerType.USER, kycTier: data.kycTier },
          update: { kycTier: data.kycTier } });
      },
      'merchant.status_updated': async (event, context) => {
        const data = event.data as { merchantId: string; status: string };
        const tx = context.tx as Prisma.TransactionClient;
        if (data.status === 'APPROVED') await tx.wallet.upsert({
          where: { userId_ownerType: { userId: data.merchantId, ownerType: OwnerType.MERCHANT } },
          create: { userId: data.merchantId, ownerType: OwnerType.MERCHANT }, update: {} });
      }
    } });
  try { await consumer.start(); }
  catch {
    await consumer.stop().catch(() => {});
    if (!stopped) retry = setTimeout(() => void startKycConsumer(), 2000);
  }
}
export async function stopKycConsumer() {
  stopped = true;
  clearTimeout(retry);
  await consumer?.stop();
  await prisma.$disconnect();
}
