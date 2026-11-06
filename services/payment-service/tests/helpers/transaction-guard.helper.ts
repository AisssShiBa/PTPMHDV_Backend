import { WalletClient } from '../../src/clients/wallet.client';
import { prisma as paymentPrismaClient } from '../../src/utils/prisma';

let isInsideTransaction = false;
let isWrapped = false;

export function enableTransactionTracking() {
  if (isWrapped) return;
  isWrapped = true;
  const originalTransaction = paymentPrismaClient.$transaction.bind(paymentPrismaClient);

  (paymentPrismaClient as any).$transaction = async (...args: any[]) => {
    if (typeof args[0] === 'function') {
      const fn = args[0];
      return originalTransaction(async (tx: any) => {
        const prev = isInsideTransaction;
        isInsideTransaction = true;
        try {
          return await fn(tx);
        } finally {
          isInsideTransaction = prev;
        }
      }, args[1]);
    }
    return (originalTransaction as any)(...args);
  };
}

export class GuardedWalletClient extends WalletClient {
  constructor() {
    super();
    enableTransactionTracking();
  }

  private assertNotInTransaction(action: string) {
    if (isInsideTransaction) {
      throw new Error(`VIOLATION: walletClient.${action} was called inside an active prisma.$transaction!`);
    }
  }

  override async createHold(userId: string, amount: string, referenceId: string, expiresAt: string, destinationUserId?: string, destinationOwnerType?: string) {
    this.assertNotInTransaction('createHold');
    return super.createHold(userId, amount, referenceId, expiresAt, destinationUserId, destinationOwnerType);
  }

  override async captureHold(userId: string, referenceId: string) {
    this.assertNotInTransaction('captureHold');
    return super.captureHold(userId, referenceId);
  }

  override async releaseHold(userId: string, referenceId: string) {
    this.assertNotInTransaction('releaseHold');
    return super.releaseHold(userId, referenceId);
  }

  override async lookupTransaction(referenceId: string) {
    this.assertNotInTransaction('lookupTransaction');
    return super.lookupTransaction(referenceId);
  }
}
