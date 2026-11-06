import { DomainException } from '../../utils/domain.exception';
import { mockPayoutEnabled, MockPayoutService, type MockPayoutRow } from '../services/mock-payout.service';

export type PayoutOutcome =
  | { outcome: 'SUCCESS' | 'FAILED'; bankTransactionId: string | null; failureCode: string | null }
  // PENDING is a first-class result: the bank may or may not have moved money,
  // so the caller must reconcile before it can conclude anything.
  | { outcome: 'PENDING' };

// Seam between the cash-out workflow and whatever actually talks to a bank.
// Today only the durable mock exists, so an unconfigured provider must fail
// closed *before* any hold is placed rather than silently answering SUCCESS.
export class PayoutClient {
  constructor(private readonly mock: MockPayoutService = new MockPayoutService()) {}

  assertConfigured(): void {
    if (!mockPayoutEnabled()) {
      throw new DomainException(503, 'PAYOUT_PROVIDER_NOT_CONFIGURED', 'No payout provider is configured');
    }
  }

  async payout(providerRef: string, amount: string): Promise<PayoutOutcome> {
    this.assertConfigured();
    return toOutcome(await this.mock.payout(providerRef, amount));
  }

  // Reads the provider's verdict without creating one. Recovery uses this so a
  // row that was already sent is never re-sent under a different reference.
  async query(providerRef: string): Promise<PayoutOutcome | null> {
    this.assertConfigured();
    const row = await this.mock.query(providerRef);
    return row ? toOutcome(row) : null;
  }
}

function toOutcome(row: MockPayoutRow): PayoutOutcome {
  return row.result === 'PENDING'
    ? { outcome: 'PENDING' }
    : { outcome: row.result, bankTransactionId: row.bankTransactionId, failureCode: row.failureCode };
}
