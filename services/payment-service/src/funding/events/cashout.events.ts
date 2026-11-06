import type { FinvaultEvent } from 'finvault-events';

type CashOutEventRow = {
  id: string;
  userId: string;
  amount: { toFixed(decimals: number): string };
};

// Both events carry the full envelope because the outbox job validates it with
// parseFinvaultEvent before publishing. cashOutId must equal the outbox row's
// aggregateId, otherwise buildPaymentFinvaultEvent rejects the row.
export function cashoutCompletedEvent(
  eventId: string,
  cashOut: CashOutEventRow,
  walletTransactionId: string | null,
): FinvaultEvent {
  return {
    eventId,
    eventType: 'funding.cashout_completed',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    data: {
      cashOutId: cashOut.id,
      userId: cashOut.userId,
      amount: cashOut.amount.toFixed(0),
      ...(walletTransactionId ? { walletTransactionId } : {}),
    },
  };
}

export function cashoutFailedEvent(eventId: string, cashOut: CashOutEventRow, reason: string): FinvaultEvent {
  return {
    eventId,
    eventType: 'funding.cashout_failed',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    data: {
      cashOutId: cashOut.id,
      userId: cashOut.userId,
      amount: cashOut.amount.toFixed(0),
      reason: reason || 'CASHOUT_FAILED',
    },
  };
}
