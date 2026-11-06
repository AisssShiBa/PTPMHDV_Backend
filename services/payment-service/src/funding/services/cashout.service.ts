import { createHash, randomUUID } from 'node:crypto';
import { CashOut, CashOutStatus, Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma';
import { DomainException } from '../../utils/domain.exception';
import { WalletClient } from '../../clients/wallet.client';
import type { TransactionTokenPayload } from '../../middlewares/transactionToken';
import { PayoutClient } from '../clients/payout.client';
import { cashoutCompletedEvent, cashoutFailedEvent } from '../events/cashout.events';

const transactionOptions = { maxWait: 15000, timeout: 25000 };
const LEASE_MS = 60_000;
// How long a hold is planned for at a time. While the bank outcome is unknown the
// hold is pushed forward by this much on every reconcile pass, so an UNKNOWN world
// never outlives a hold the Wallet still considers capturable (STOP-1).
const HOLD_TTL_MS = Number(process.env.CASHOUT_HOLD_TTL_MS || 300_000);
const RETRY_BASE_MS = 5_000;

const TERMINAL: CashOutStatus[] = ['SUCCEEDED', 'FAILED'];

function backoff(attempt: number): Date {
  const delay = Math.min(60_000, RETRY_BASE_MS * 2 ** Math.min(attempt, 4));
  return new Date(Date.now() + delay);
}

function holdRefFor(id: string): string {
  return `cashout_${id}`;
}

function providerRefFor(id: string): string {
  return `cashoutpay_${id}`;
}

// Stable hash so the same key with the same payload replays and the same key
// with a different payload is rejected instead of silently reusing the order.
function requestHash(amount: Prisma.Decimal, destination: string | null): string {
  return createHash('sha256')
    .update(JSON.stringify([amount.toFixed(0), destination || '']))
    .digest('hex');
}

// A 4xx that names a business refusal is deterministic: retrying it can never
// succeed, so the order must fail instead of looping. Anything else - 5xx,
// timeout, 401/403 (our own misconfiguration), 404, 408, 429 - is ambiguous
// because the Wallet may already have applied the change.
const DETERMINISTIC_HOLD_CODES = new Set([
  'INSUFFICIENT_BALANCE',
  'LIMIT_EXCEEDED',
  'WALLET_LOCKED',
  'REFERENCE_ID_REUSED',
  'INVALID_AMOUNT',
  'INVALID_HOLD_EXPIRY',
  'WALLET_NOT_FOUND',
]);

function isDeterministicHardReject(error: unknown): error is DomainException {
  return error instanceof DomainException && error.status < 500 && DETERMINISTIC_HOLD_CODES.has(error.code);
}

export type CreateCashOutInput = {
  userId: string;
  idempotencyKey: string;
  amount: string;
  destination?: string;
};

export class CashOutService {
  constructor(
    private readonly wallet: WalletClient = new WalletClient(),
    private readonly payout: PayoutClient = new PayoutClient(),
    // Injectable so unit tests run the real state machine against a fake store.
    private readonly store: typeof prisma = prisma,
  ) {}

  async create(input: CreateCashOutInput) {
    const amount = new Prisma.Decimal(input.amount);
    // decimal.js counts +0 as "positive", so zero needs its own check.
    if (!amount.isInteger() || amount.isZero() || amount.isNegative()) {
      throw new DomainException(400, 'INVALID_AMOUNT', 'Amount must be a positive whole VND value');
    }
    const destination = input.destination?.trim() || null;
    const hash = requestHash(amount, destination);
    const id = randomUUID();

    try {
      const cashOut = await this.store.cashOut.create({
        data: {
          id,
          userId: input.userId,
          amount,
          destination,
          idempotencyKey: input.idempotencyKey,
          requestHash: hash,
          status: 'REQUESTED',
          workflow: 'IDLE',
          holdRef: holdRefFor(id),
          logs: { create: { toStatus: 'REQUESTED', note: 'Cash-out requested' } },
        },
      });
      return { cashOut, replayed: false };
    } catch (error: any) {
      if (error?.code !== 'P2002') throw error;
      const previous = await this.store.cashOut.findUnique({
        where: { userId_idempotencyKey: { userId: input.userId, idempotencyKey: input.idempotencyKey } },
      });
      if (!previous) throw error;
      if (previous.requestHash !== hash) {
        throw new DomainException(422, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'Idempotency key has a different payload');
      }
      return { cashOut: previous, replayed: true };
    }
  }

  async confirm(id: string, userId: string, token: TransactionTokenPayload) {
    await this.store.$transaction(async (tx) => {
      const cashOut = await this.locked(tx, id);
      if (cashOut.userId !== userId || token.sub !== userId || token.paymentId !== id ||
          !cashOut.amount.equals(token.amount)) {
        throw new DomainException(403, 'TXN_TOKEN_MISMATCH', 'Token does not authorize this cash-out');
      }
      // One jti is valid exactly once across Payment and CashOut, so the replay
      // check must run before any state is written.
      if (await tx.usedTransactionToken.findUnique({ where: { jti: token.jti } })) {
        throw new DomainException(409, 'TXN_TOKEN_REUSED', 'Transaction token already used');
      }
      if (cashOut.status !== 'REQUESTED' || cashOut.workflow !== 'IDLE') {
        throw new DomainException(409, 'CASHOUT_NOT_CONFIRMABLE', 'Cash-out cannot be confirmed');
      }
      // The provider refuses to run without a configured bank; fail before
      // consuming the token so the user is not left with a dead order.
      this.payout.assertConfigured();

      await tx.usedTransactionToken.create({ data: { jti: token.jti, paymentId: id, userId } });
      await tx.cashOut.update({
        where: { id },
        data: {
          tokenJti: token.jti,
          providerRef: providerRefFor(id),
          status: 'HOLDING',
          workflow: 'HOLDING',
          logs: { create: { fromStatus: 'REQUESTED', toStatus: 'HOLDING', note: 'PIN token accepted' } },
        },
      });
    }, transactionOptions);

    // Money moves only after the claim is durable.
    return this.drive(id);
  }

  // Recovery entry point: same driver, so a restart continues exactly where the
  // crashed worker stopped instead of issuing a second hold or payout.
  async drive(id: string) {
    const leaseToken = randomUUID();
    const claimed = await this.store.cashOut.updateMany({
      where: {
        id,
        status: { notIn: TERMINAL },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      data: { leaseToken, leaseUntil: new Date(Date.now() + LEASE_MS) },
    });
    if (claimed.count !== 1) return this.store.cashOut.findUnique({ where: { id } });
    try {
      return await this.run(id, leaseToken);
    } finally {
      await this.store.cashOut.updateMany({
        where: { id, leaseToken },
        data: { leaseToken: null, leaseUntil: null },
      }).catch(() => undefined);
    }
  }

  private async run(id: string, leaseToken: string): Promise<CashOut | null> {
    // Bounded loop: each iteration advances one workflow step and re-reads state.
    for (let step = 0; step < 5; step++) {
      const cashOut = await this.store.cashOut.findUnique({ where: { id } });
      if (!cashOut || TERMINAL.includes(cashOut.status)) return cashOut;

      if (cashOut.workflow === 'HOLDING') {
        const outcome = await this.placeHold(cashOut, leaseToken);
        if (outcome !== 'continue') return outcome;
        continue;
      }

      if (cashOut.workflow === 'PAYOUT') {
        const outcome = await this.issuePayout(cashOut, leaseToken);
        if (outcome !== 'continue') return outcome;
        continue;
      }

      if (cashOut.workflow === 'CAPTURING') {
        return this.capture(cashOut, leaseToken);
      }

      if (cashOut.workflow === 'RELEASING') {
        return this.release(cashOut, leaseToken);
      }

      if (cashOut.workflow === 'AWAIT_RECONCILE') {
        // Keep the hold alive before asking the bank anything: a pass spent on an
        // UNKNOWN answer must still leave a capturable hold for the next one.
        await this.protectHold(cashOut);
        const outcome = await this.reconcile(cashOut, leaseToken);
        if (outcome !== 'continue') return outcome;
        continue;
      }

      // REQUESTED/IDLE needs a user confirm; nothing for the worker to do.
      return cashOut;
    }
    return this.store.cashOut.findUnique({ where: { id } });
  }

  private async placeHold(cashOut: CashOut, leaseToken: string): Promise<CashOut | 'continue' | null> {
    try {
      await this.wallet.createHold(
        cashOut.userId,
        cashOut.amount.toFixed(0),
        cashOut.holdRef,
        new Date(Date.now() + HOLD_TTL_MS).toISOString(),
      );
    } catch (error) {
      if (isDeterministicHardReject(error)) {
        return this.finish(cashOut, leaseToken, 'FAILED', error.code);
      }
      console.error('[CashOut] Hold outcome unknown; will reconcile by holdRef', { id: cashOut.id });
      await this.scheduleRetry(cashOut, leaseToken);
      return null;
    }
    // Persist PAYOUT before the bank is contacted so a crash cannot lose the
    // fact that a payout is about to be issued.
    await this.store.cashOut.updateMany({
      where: { id: cashOut.id, leaseToken, status: 'HOLDING' },
      data: { workflow: 'PAYOUT' },
    });
    return 'continue';
  }

  private async issuePayout(cashOut: CashOut, leaseToken: string): Promise<CashOut | 'continue' | null> {
    if (!cashOut.providerRef) {
      return this.finish(cashOut, leaseToken, 'FAILED', 'MISSING_PROVIDER_REF');
    }
    let outcome;
    try {
      outcome = await this.payout.payout(cashOut.providerRef, cashOut.amount.toFixed(0));
    } catch (error) {
      console.error('[CashOut] Payout call failed; provider state unknown', {
        id: cashOut.id,
        error: error instanceof Error ? error.message : 'unknown error',
      });
      await this.toStatus(cashOut, leaseToken, 'PAYOUT_PENDING', 'AWAIT_RECONCILE');
      return null;
    }

    if (outcome.outcome === 'SUCCESS') {
      await this.toWorkflow(cashOut, leaseToken, 'CAPTURING');
      return 'continue';
    }
    if (outcome.outcome === 'FAILED') {
      await this.toWorkflow(cashOut, leaseToken, 'RELEASING');
      return 'continue';
    }
    // Bank UNKNOWN: never release or capture on a guess (plan §6.5).
    await this.toStatus(cashOut, leaseToken, 'PAYOUT_PENDING', 'AWAIT_RECONCILE');
    return null;
  }

  // DO NOT make this terminal. Extending is best effort: a Wallet that already
  // captured, released or expired the hold answers 409, and the provider may still
  // settle SUCCESS, so the pass must continue and let capture() decide. Failing a
  // cash-out on an extend error would fail orders that are still recoverable.
  private async protectHold(cashOut: CashOut): Promise<void> {
    try {
      await this.wallet.extendHold(
        cashOut.userId,
        cashOut.holdRef,
        new Date(Date.now() + HOLD_TTL_MS).toISOString(),
      );
    } catch (error) {
      console.warn('[CashOut] Hold extend failed; continuing to reconcile', {
        id: cashOut.id,
        code: error instanceof DomainException ? error.code : null,
        error: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  private async reconcile(cashOut: CashOut, leaseToken: string): Promise<CashOut | 'continue' | null> {
    if (!cashOut.providerRef) {
      return this.finish(cashOut, leaseToken, 'FAILED', 'MISSING_PROVIDER_REF');
    }
    const outcome = await this.payout.query(cashOut.providerRef).catch(() => null);
    // A missing provider row is ambiguous, not a failure: keep waiting.
    if (!outcome || outcome.outcome === 'PENDING') {
      await this.scheduleRetry(cashOut, leaseToken);
      return null;
    }
    if (outcome.outcome === 'SUCCESS') {
      await this.toWorkflow(cashOut, leaseToken, 'CAPTURING');
      return 'continue';
    }
    await this.toWorkflow(cashOut, leaseToken, 'RELEASING');
    return 'continue';
  }

  private async capture(cashOut: CashOut, leaseToken: string): Promise<CashOut | null> {
    let transactionId: string | null = null;
    try {
      const result: any = await this.wallet.captureHold(cashOut.userId, cashOut.holdRef);
      transactionId = result?.transactionId ?? null;
    } catch (error) {
      const code = error instanceof DomainException ? error.code : null;
      if (code === 'HOLD_EXPIRED' || code === 'HOLD_NOT_CAPTURABLE') {
        // The bank already paid but the hold is gone: money left the system and
        // cannot be recovered by this workflow. Surface it loudly for manual
        // reconciliation instead of inventing a SUCCESS or silently refunding.
        console.error('[CashOut] STOP-1: bank SUCCEEDED but hold is no longer capturable', {
          id: cashOut.id,
          code,
        });
        return this.finish(cashOut, leaseToken, 'FAILED', 'RECONCILE_HOLD_EXPIRED');
      }
      console.error('[CashOut] Capture outcome unknown; will retry with the same holdRef', { id: cashOut.id });
      await this.scheduleRetry(cashOut, leaseToken);
      return null;
    }
    return this.finish(cashOut, leaseToken, 'SUCCEEDED', null, transactionId);
  }

  private async release(cashOut: CashOut, leaseToken: string): Promise<CashOut | null> {
    try {
      await this.wallet.releaseHold(cashOut.userId, cashOut.holdRef);
    } catch (error) {
      const code = error instanceof DomainException ? error.code : null;
      if (code === 'HOLD_NOT_FOUND') {
        // No hold was ever placed, so nothing is owed back to the user.
        return this.finish(cashOut, leaseToken, 'FAILED', 'HOLD_NOT_FOUND');
      }
      if (code === 'HOLD_ALREADY_CAPTURED') {
        console.error('[CashOut] Bank reported FAILED but the hold was captured; reconcile manually', {
          id: cashOut.id,
        });
        await this.scheduleRetry(cashOut, leaseToken);
        return null;
      }
      console.error('[CashOut] Release outcome unknown; will retry with the same holdRef', { id: cashOut.id });
      await this.scheduleRetry(cashOut, leaseToken);
      return null;
    }
    return this.finish(cashOut, leaseToken, 'FAILED', 'BANK_DECLINED');
  }

  private async finish(
    cashOut: CashOut,
    leaseToken: string,
    status: Extract<CashOutStatus, 'SUCCEEDED' | 'FAILED'>,
    reason: string | null,
    walletTransactionId: string | null = null,
  ): Promise<CashOut | null> {
    return this.store.$transaction(async (tx) => {
      const current = await this.locked(tx, cashOut.id);
      // A worker that lost its lease must never commit a terminal state.
      if (current.leaseToken !== leaseToken) return current;
      if (TERMINAL.includes(current.status)) return current;

      const updated = await tx.cashOut.update({
        where: { id: current.id },
        data: {
          status,
          workflow: 'IDLE',
          failureReason: reason,
          walletTransactionId,
          nextRetryAt: null,
          leaseToken: null,
          leaseUntil: null,
          logs: { create: { fromStatus: current.status, toStatus: status, note: reason || status } },
        },
      });

      const eventId = randomUUID();
      const event = status === 'SUCCEEDED'
        ? cashoutCompletedEvent(eventId, updated, walletTransactionId)
        : cashoutFailedEvent(eventId, updated, reason || 'CASHOUT_FAILED');
      await tx.outboxEvent.create({
        data: {
          id: eventId,
          aggregateId: updated.id,
          eventType: event.eventType,
          topic: 'finvault.events',
          payload: event as unknown as Prisma.InputJsonValue,
        },
      });
      return updated;
    }, transactionOptions);
  }

  private async scheduleRetry(cashOut: CashOut, leaseToken: string) {
    const attempt = cashOut.retryCount + 1;
    await this.store.cashOut.updateMany({
      where: { id: cashOut.id, leaseToken, status: { notIn: TERMINAL } },
      data: { retryCount: attempt, nextRetryAt: backoff(attempt) },
    });
  }

  private async toWorkflow(cashOut: CashOut, leaseToken: string, workflow: string) {
    await this.store.cashOut.updateMany({
      where: { id: cashOut.id, leaseToken, status: { notIn: TERMINAL } },
      data: { workflow },
    });
  }

  private async toStatus(cashOut: CashOut, leaseToken: string, status: CashOutStatus, workflow: string) {
    await this.store.$transaction(async (tx) => {
      const current = await this.locked(tx, cashOut.id);
      if (current.leaseToken !== leaseToken) return;
      if (TERMINAL.includes(current.status) || current.status === status) {
        if (current.workflow !== workflow) {
          await tx.cashOut.update({ where: { id: current.id }, data: { workflow } });
        }
        return;
      }
      await tx.cashOut.update({
        where: { id: current.id },
        data: {
          status,
          workflow,
          nextRetryAt: null,
          logs: { create: { fromStatus: current.status, toStatus: status, note: status } },
        },
      });
    }, transactionOptions);
  }

  private async locked(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT id FROM "CashOut" WHERE id=${id}::uuid FOR UPDATE`;
    const cashOut = await tx.cashOut.findUnique({ where: { id } });
    if (!cashOut) throw new DomainException(404, 'CASHOUT_NOT_FOUND', 'Cash-out not found');
    return cashOut;
  }

  async get(id: string, userId: string, role?: string) {
    const cashOut = await this.store.cashOut.findUnique({ where: { id } });
    if (!cashOut) throw new DomainException(404, 'CASHOUT_NOT_FOUND', 'Cash-out not found');
    if (cashOut.userId !== userId && role !== 'ADMIN') {
      throw new DomainException(403, 'FORBIDDEN', 'Cash-out belongs to another user');
    }
    return cashOut;
  }

  async recover(batch = 50) {
    const stuck = await this.store.cashOut.findMany({
      where: {
        status: { notIn: TERMINAL },
        workflow: { not: 'IDLE' },
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lt: new Date() } }],
      },
      take: batch,
      orderBy: { updatedAt: 'asc' },
    });
    for (const cashOut of stuck) {
      try {
        await this.drive(cashOut.id);
      } catch (error) {
        console.error('[CashOut] Recovery will retry', {
          id: cashOut.id,
          error: error instanceof Error ? error.message : 'unknown error',
        });
      }
    }
    return stuck.length;
  }
}
