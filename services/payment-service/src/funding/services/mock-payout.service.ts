import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma';
import { DomainException } from '../../utils/domain.exception';

// The stand-in bank. It is an external dependency of cash-out, not a business
// rule, so its only job is to answer deterministically and to be durable per
// providerRef: a retried payout must never move money twice.
export type MockPayoutOutcome = 'PENDING' | 'SUCCESS' | 'FAILED';

export function mockPayoutEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Plan §6.4: refuse the mock in production even when the operator sets the
  // flag. A misconfigured flag must not be able to fake bank transfers.
  return env.MOCK_PAYOUT_ENABLED === 'true' && env.NODE_ENV !== 'production';
}

export function mockPayoutPlan(amount: string): { result: MockPayoutOutcome; timeoutResponse: boolean; failureCode: string | null } {
  if (!/^\d+$/.test(amount)) throw new DomainException(400, 'INVALID_AMOUNT', 'Amount must be a whole VND value');
  if (amount.endsWith('111')) return { result: 'FAILED', timeoutResponse: false, failureCode: 'BANK_DECLINED' };
  // 222 answers "unknown": the row exists but the provider has not concluded.
  // A caller that retries must query, never assume failure.
  if (amount.endsWith('222')) return { result: 'PENDING', timeoutResponse: true, failureCode: null };
  return { result: 'SUCCESS', timeoutResponse: false, failureCode: null };
}

export type MockPayoutRow = {
  providerRef: string;
  amount: Prisma.Decimal;
  result: MockPayoutOutcome;
  timeoutResponse: boolean;
  bankTransactionId: string | null;
  failureCode: string | null;
};

const defaultStore = prisma;

export class MockPayoutService {
  constructor(private readonly store: any = defaultStore) {}

  async payout(providerRef: string, amount: string): Promise<MockPayoutRow> {
    const existing = await this.store.mockPayout.findUnique({ where: { providerRef } });
    if (existing) return existing;

    const plan = mockPayoutPlan(amount);
    const decimal = new Prisma.Decimal(amount);
    try {
      return await this.store.mockPayout.create({
        data: {
          providerRef,
          amount: decimal,
          result: plan.result,
          timeoutResponse: plan.timeoutResponse,
          failureCode: plan.failureCode,
          bankTransactionId: plan.result === 'SUCCESS' ? 'BANK-' + randomUUID() : null,
        },
      });
    } catch (error: any) {
      // Two concurrent retries cannot both insert; the loser replays the winner.
      if (error?.code !== 'P2002') throw error;
      const row = await this.store.mockPayout.findUnique({ where: { providerRef } });
      if (!row) throw error;
      return row;
    }
  }

  async query(providerRef: string): Promise<MockPayoutRow | null> {
    return this.store.mockPayout.findUnique({ where: { providerRef } });
  }

  // Operator/test hook that lets an UNKNOWN outcome become definitive, which is
  // the only thing that may settle a PAYOUT_PENDING cash-out.
  async resolve(providerRef: string, result: 'SUCCESS' | 'FAILED'): Promise<MockPayoutRow> {
    const row = await this.store.mockPayout.findUnique({ where: { providerRef } });
    if (!row) throw new DomainException(404, 'PAYOUT_NOT_FOUND', 'Payout not found');
    if (row.result !== 'PENDING') return row;
    return this.store.mockPayout.update({
      where: { providerRef },
      data: {
        result,
        bankTransactionId: result === 'SUCCESS' ? row.bankTransactionId || 'BANK-' + randomUUID() : row.bankTransactionId,
        failureCode: result === 'FAILED' ? row.failureCode || 'BANK_DECLINED' : null,
      },
    });
  }
}
