import { WalletClient } from '../../src/clients/wallet.client';
import { prisma as paymentPrismaClient } from '../../src/utils/prisma';
import { AsyncLocalStorage } from 'node:async_hooks';

const txStorage = new AsyncLocalStorage<boolean>();
let isWrapped = false;

export function enableTransactionTracking() {
  if (isWrapped) return;
  isWrapped = true;
  const originalTransaction = paymentPrismaClient.$transaction.bind(paymentPrismaClient);

  (paymentPrismaClient as any).$transaction = async (...args: any[]) => {
    if (typeof args[0] === 'function') {
      const fn = args[0];
      return txStorage.run(true, async () => {
        return originalTransaction(fn, args[1]);
      });
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
    if (txStorage.getStore() === true) {
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

  override async extendHold(userId: string, referenceId: string, expiresAt: string) {
    this.assertNotInTransaction('extendHold');
    return super.extendHold(userId, referenceId, expiresAt);
  }

  override async refundCapture(userId: string, originalReferenceId: string, referenceId: string, amount: string) {
    this.assertNotInTransaction('refundCapture');
    return super.refundCapture(userId, originalReferenceId, referenceId, amount);
  }

  override async refundCredit(userId: string, amount: string, referenceId: string) {
    this.assertNotInTransaction('refundCredit');
    return super.refundCredit(userId, amount, referenceId);
  }

  override async topupCredit(userId: string, amount: string, referenceId: string) {
    this.assertNotInTransaction('topupCredit');
    return super.topupCredit(userId, amount, referenceId);
  }

  override async getBalance(userId: string) {
    this.assertNotInTransaction('getBalance');
    return super.getBalance(userId);
  }
}
