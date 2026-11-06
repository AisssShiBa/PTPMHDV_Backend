import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';

// Exercises the cash-out state machine against an in-memory store, so the real
// transition code runs while money is never touched. The wallet and payout are
// stubs whose call counts prove C01/C02/C06/C11: one hold, one payout, one
// capture or release, regardless of retries.

type Row = Record<string, any>;

function fakeStore() {
  const cashOuts = new Map<string, Row>();
  const tokens = new Map<string, Row>();
  const outbox: Row[] = [];

  const matches = (row: Row, where: any) => {
    for (const [key, value] of Object.entries(where ?? {})) {
      if (key === 'OR') {
        if (!(value as any[]).some(clause => {
          if (clause.leaseUntil === null) return row.leaseUntil == null;
          if (clause.leaseUntil?.lt) return row.leaseUntil != null && row.leaseUntil < clause.leaseUntil.lt;
          if (clause.nextRetryAt === null) return row.nextRetryAt == null;
          if (clause.nextRetryAt?.lt) return row.nextRetryAt != null && row.nextRetryAt < clause.nextRetryAt.lt;
          return false;
        })) return false;
        continue;
      }
      if (key === 'status' && value?.notIn) {
        if (value.notIn.includes(row.status)) return false;
        continue;
      }
      if (key === 'workflow' && value?.not !== undefined) {
        if (row.workflow === value.not) return false;
        continue;
      }
      if (value?.lt !== undefined) {
        if (!(row[key] != null && row[key] < value.lt)) return false;
        continue;
      }
      if (value?.notIn) {
        if (value.notIn.includes(row[key])) return false;
        continue;
      }
      if (row[key] !== value) return false;
    }
    return true;
  };

  const cashOutModel: any = {
    __rows: cashOuts,
    create: async ({ data }: any) => {
      for (const row of cashOuts.values()) {
        if (row.userId === data.userId && row.idempotencyKey === data.idempotencyKey) {
          const error: any = new Error('Unique constraint failed');
          error.code = 'P2002';
          throw error;
        }
      }
      const row = { ...data, retryCount: 0, leaseToken: null, leaseUntil: null,
        failureReason: null, nextRetryAt: null, walletTransactionId: null, createdAt: new Date(), updatedAt: new Date() };
      cashOuts.set(data.id, row);
      return row;
    },
    findUnique: async ({ where }: any) => {
      if (where.userId_idempotencyKey) {
        const { userId, idempotencyKey } = where.userId_idempotencyKey;
        return [...cashOuts.values()].find(r => r.userId === userId && r.idempotencyKey === idempotencyKey) ?? null;
      }
      return cashOuts.get(where.id) ?? null;
    },
    findMany: async ({ where }: any) =>
      [...cashOuts.values()].filter(row => matches(row, where)),
    update: async ({ where, data }: any) => {
      const row = cashOuts.get(where.id)!;
      Object.assign(row, data, { updatedAt: new Date() });
      delete row.logs;
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      // Prisma updateMany rejects nested relation writes; the fake enforces it
      // so a regression to `logs: { create }` fails here instead of in prod.
      if (data.logs !== undefined) throw new Error('Unknown argument `logs` on updateMany');
      let count = 0;
      for (const row of cashOuts.values()) {
        if (!matches(row, where)) continue;
        count++;
        Object.assign(row, data, { updatedAt: new Date() });
      }
      return { count };
    },
  };

  const store: any = {
    __cashOuts: cashOuts,
    __tokens: tokens,
    __outbox: outbox,
    cashOut: cashOutModel,
    usedTransactionToken: {
      findUnique: async ({ where }: any) => tokens.get(where.jti) ?? null,
      create: async ({ data }: any) => {
        if (tokens.has(data.jti)) {
          const error: any = new Error('Unique constraint failed');
          error.code = 'P2002';
          throw error;
        }
        tokens.set(data.jti, data);
        return data;
      },
    },
    outboxEvent: {
      create: async ({ data }: any) => { outbox.push(data); return data; },
    },
    $queryRaw: async () => [{ id: 'locked' }],
    $transaction: async (fn: any) => fn(store),
  };
  return store;
}

function walletStub(plan: { hold?: () => Promise<any>; capture?: () => Promise<any>; release?: () => Promise<any>; extend?: () => Promise<any> } = {}) {
  const calls = { hold: 0, capture: 0, release: 0, extend: 0 };
  return {
    calls,
    createHold: async () => { calls.hold++; return plan.hold ? plan.hold() : { id: 'h', replayed: false }; },
    extendHold: async () => { calls.extend++; return plan.extend ? plan.extend() : { extended: true, replayed: false }; },
    captureHold: async () => { calls.capture++; return plan.capture ? plan.capture() : { transactionId: 'tx-1', replayed: false }; },
    releaseHold: async () => { calls.release++; return plan.release ? plan.release() : { replayed: false }; },
  } as any;
}

function payoutStub(outcome: any, queried?: any) {
  const calls = { payout: 0, query: 0 };
  return {
    calls,
    assertConfigured() {},
    payout: async () => { calls.payout++; return outcome; },
    query: async () => { calls.query++; return queried ?? null; },
  } as any;
}

// The service graph reads its internal key at import time; a synthetic value
// keeps this suite database-free and secret-free.
process.env.INTERNAL_KEY = 'synthetic-payment-test-key';

const { CashOutService } = require('../src/funding/services/cashout.service');
const { DomainException } = require('../src/utils/domain.exception');

const USER = '22222222-2222-4222-8222-222222222222';
const ID = '11111111-1111-4111-8111-111111111111';

function token(overrides: Record<string, any> = {}) {
  return {
    iss: 'finvault-auth-service', aud: 'finvault-payment-service', sub: USER,
    paymentId: ID, amount: '100000', jti: '33333333-3333-4333-8333-333333333333',
    ...overrides,
  } as any;
}

// `confirm`/`drive` answer with the row only when the outcome is known; an
// ambiguous outcome returns null and the durable row is the source of truth.
async function rowOf(store: any, id: string) {
  return store.cashOut.findUnique({ where: { id } });
}

async function seedRequested(store: any, amount = '100000') {
  const service = new CashOutService(walletStub(), payoutStub({ outcome: 'SUCCESS' }), store);
  return service.create({ userId: USER, idempotencyKey: 'key-1', amount });
}

test('C01 success: one hold, one payout, one capture, SUCCEEDED + outbox event', async () => {
  const store = fakeStore();
  const wallet = walletStub();
  const payout = payoutStub({ outcome: 'SUCCESS', bankTransactionId: 'BANK-1', failureCode: null });
  const service = new CashOutService(wallet, payout, store);

  const created = await service.create({ userId: USER, idempotencyKey: 'k1', amount: '100000' });
  assert.equal(created.cashOut.status, 'REQUESTED');

  const result = await service.confirm(created.cashOut.id, USER, token({ paymentId: created.cashOut.id }));
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(wallet.calls.hold, 1);
  assert.equal(payout.calls.payout, 1);
  assert.equal(wallet.calls.capture, 1, 'C01: captured exactly once');
  assert.equal(wallet.calls.release, 0);
  assert.equal(store.__outbox.length, 1);
  assert.equal(store.__outbox[0].eventType, 'funding.cashout_completed');
  assert.equal(store.__outbox[0].aggregateId, created.cashOut.id);
});

test('C02 bank failure: release once, no capture, FAILED + failed event', async () => {
  const store = fakeStore();
  const wallet = walletStub();
  const payout = payoutStub({ outcome: 'FAILED', bankTransactionId: null, failureCode: 'BANK_DECLINED' });
  const service = new CashOutService(wallet, payout, store);

  const created = await service.create({ userId: USER, idempotencyKey: 'k2', amount: '100111' });
  const result = await service.confirm(created.cashOut.id, USER, token({ paymentId: created.cashOut.id, amount: '100111' }));

  assert.equal(result!.status, 'FAILED');
  assert.equal(wallet.calls.release, 1);
  assert.equal(wallet.calls.capture, 0, 'C02: a declined payout must never capture');
  assert.equal(store.__outbox[0].eventType, 'funding.cashout_failed');
});

test('C03 unknown payout: PAYOUT_PENDING, hold kept, no release or capture', async () => {
  const store = fakeStore();
  const wallet = walletStub();
  const payout = payoutStub({ outcome: 'PENDING' }, { outcome: 'PENDING' });
  const service = new CashOutService(wallet, payout, store);

  const created = await service.create({ userId: USER, idempotencyKey: 'k3', amount: '100222' });
  const result = await service.confirm(created.cashOut.id, USER, token({ paymentId: created.cashOut.id, amount: '100222' }));

  assert.equal(result, null, 'an UNKNOWN payout is not reported as a settled result');
  const row = await rowOf(store, created.cashOut.id);
  assert.equal(row.status, 'PAYOUT_PENDING');
  assert.equal(row.workflow, 'AWAIT_RECONCILE');
  assert.equal(wallet.calls.release, 0, 'STOP-1: an UNKNOWN bank result must not release the hold');
  assert.equal(wallet.calls.capture, 0, 'an UNKNOWN bank result must not capture');
  assert.equal(store.__outbox.length, 0, 'no terminal event while the outcome is unknown');
});

test('C03 recovery: provider later reports SUCCESS -> capture exactly once', async () => {
  const store = fakeStore();
  const wallet = walletStub();
  const payout = payoutStub({ outcome: 'PENDING' }, { outcome: 'SUCCESS', bankTransactionId: 'BANK-2', failureCode: null });
  const service = new CashOutService(wallet, payout, store);

  const created = await service.create({ userId: USER, idempotencyKey: 'k4', amount: '100222' });
  await service.confirm(created.cashOut.id, USER, token({ paymentId: created.cashOut.id, amount: '100222' }));

  const recovered = await service.drive(created.cashOut.id);
  assert.equal(recovered!.status, 'SUCCEEDED');
  assert.equal(payout.calls.payout, 1, 'recovery queries the provider instead of re-sending the payout');
  assert.equal(payout.calls.query, 1);
  assert.equal(wallet.calls.capture, 1);
});

test('C03 recovery: provider later reports FAILED -> release, FAILED', async () => {
  const store = fakeStore();
  const wallet = walletStub();
  const payout = payoutStub({ outcome: 'PENDING' }, { outcome: 'FAILED', bankTransactionId: null, failureCode: 'BANK_DECLINED' });
  const service = new CashOutService(wallet, payout, store);

  const created = await service.create({ userId: USER, idempotencyKey: 'k5', amount: '100222' });
  await service.confirm(created.cashOut.id, USER, token({ paymentId: created.cashOut.id, amount: '100222' }));
  const recovered = await service.drive(created.cashOut.id);

  assert.equal(recovered!.status, 'FAILED');
  assert.equal(payout.calls.payout, 1);
  assert.equal(wallet.calls.release, 1);
});

test('C04 same key and payload replays the same CashOut, one record', async () => {
  const store = fakeStore();
  const service = new CashOutService(walletStub(), payoutStub({ outcome: 'SUCCESS' }), store);

  const first = await service.create({ userId: USER, idempotencyKey: 'same', amount: '50000' });
  const second = await service.create({ userId: USER, idempotencyKey: 'same', amount: '50000' });

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.cashOut.id, first.cashOut.id);
  assert.equal(store.__cashOuts.size, 1);
});

test('C05 same key, different amount is rejected with no side effect', async () => {
  const store = fakeStore();
  const service = new CashOutService(walletStub(), payoutStub({ outcome: 'SUCCESS' }), store);
  await service.create({ userId: USER, idempotencyKey: 'conflict', amount: '50000' });

  await assert.rejects(
    () => service.create({ userId: USER, idempotencyKey: 'conflict', amount: '90000' }),
    (error: any) => error instanceof DomainException && error.code === 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' && error.status === 422,
  );
  assert.equal(store.__cashOuts.size, 1);
});

test('C06 two confirms with the same token: exactly one claim', async () => {
  const store = fakeStore();
  const wallet = walletStub();
  const payout = payoutStub({ outcome: 'SUCCESS', bankTransactionId: 'B', failureCode: null });
  const service = new CashOutService(wallet, payout, store);
  const created = await service.create({ userId: USER, idempotencyKey: 'k6', amount: '100000' });

  const results = await Promise.allSettled([
    service.confirm(created.cashOut.id, USER, token({ paymentId: created.cashOut.id })),
    service.confirm(created.cashOut.id, USER, token({ paymentId: created.cashOut.id })),
  ]);
  const rejected = results.filter(r => r.status === 'rejected');
  assert.equal(rejected.length, 1, 'the losing confirm must be rejected');
  assert.equal(payout.calls.payout, 1, 'C06: at most one payout');
  assert.equal(wallet.calls.hold, 1, 'C06: at most one hold');
});

test('C07 token bound to another payment is refused with no hold', async () => {
  const store = fakeStore();
  const wallet = walletStub();
  const service = new CashOutService(wallet, payoutStub({ outcome: 'SUCCESS' }), store);
  const created = await service.create({ userId: USER, idempotencyKey: 'k7', amount: '100000' });

  await assert.rejects(
    () => service.confirm(created.cashOut.id, USER, token({ paymentId: '44444444-4444-4444-8444-444444444444' })),
    (error: any) => error instanceof DomainException && error.code === 'TXN_TOKEN_MISMATCH' && error.status === 403,
  );
  assert.equal(wallet.calls.hold, 0);
});

test('C09 a jti already spent by Payment is refused before any hold', async () => {
  const store = fakeStore();
  const wallet = walletStub();
  const service = new CashOutService(wallet, payoutStub({ outcome: 'SUCCESS' }), store);
  const created = await service.create({ userId: USER, idempotencyKey: 'k9', amount: '100000' });
  await store.usedTransactionToken.create({ data: { jti: token().jti, paymentId: 'other', userId: USER } });

  await assert.rejects(
    () => service.confirm(created.cashOut.id, USER, token({ paymentId: created.cashOut.id })),
    (error: any) => error instanceof DomainException && error.code === 'TXN_TOKEN_REUSED' && error.status === 409,
  );
  assert.equal(wallet.calls.hold, 0, 'C09: a replayed jti must never reach the wallet');
});

test('C10 deterministic wallet rejection fails the order without contacting the bank', async () => {
  const store = fakeStore();
  const wallet = walletStub({
    hold: async () => { throw new DomainException(409, 'INSUFFICIENT_BALANCE', 'not enough'); },
  });
  const payout = payoutStub({ outcome: 'SUCCESS' });
  const service = new CashOutService(wallet, payout, store);
  const created = await service.create({ userId: USER, idempotencyKey: 'k10', amount: '100000' });

  const result = await service.confirm(created.cashOut.id, USER, token({ paymentId: created.cashOut.id }));
  assert.equal(result!.status, 'FAILED');
  assert.equal(result!.failureReason, 'INSUFFICIENT_BALANCE');
  assert.equal(payout.calls.payout, 0, 'no bank payout when no money was held');
});

test('C10 ambiguous wallet failure schedules a retry instead of failing the order', async () => {
  const store = fakeStore();
  const wallet = walletStub({
    hold: async () => { throw new DomainException(503, 'WALLET_UNAVAILABLE', 'timeout'); },
  });
  const service = new CashOutService(wallet, payoutStub({ outcome: 'SUCCESS' }), store);
  const created = await service.create({ userId: USER, idempotencyKey: 'k11', amount: '100000' });

  const result = await service.confirm(created.cashOut.id, USER, token({ paymentId: created.cashOut.id }));
  assert.equal(result, null, 'an unknown hold outcome is not reported as a terminal or settled result');
  const row = await rowOf(store, created.cashOut.id);
  assert.equal(row.status, 'HOLDING', 'an ambiguous hold must stay recoverable');
  assert.ok(row.nextRetryAt, 'a retry must be scheduled');
  assert.equal(store.__outbox.length, 0);
});

test('C11 crash after payout before capture resumes with the same refs', async () => {
  const store = fakeStore();
  const wallet = walletStub();
  const payout = payoutStub({ outcome: 'SUCCESS', bankTransactionId: 'B', failureCode: null });
  const service = new CashOutService(wallet, payout, store);
  const created = await service.create({ userId: USER, idempotencyKey: 'k12', amount: '100000' });

  // Simulate a crash after the bank answered but before capture ran.
  const { cashOut } = created;
  Object.assign(store.__cashOuts.get(cashOut.id), {
    status: 'HOLDING', workflow: 'CAPTURING', providerRef: `cashoutpay_${cashOut.id}`, holdRef: `cashout_${cashOut.id}`,
  });

  const recovered = await service.drive(cashOut.id);
  assert.equal(recovered!.status, 'SUCCEEDED');
  assert.equal(payout.calls.payout, 0, 'C11: recovery must not re-send the payout');
  assert.equal(wallet.calls.capture, 1, 'C11: capture happens exactly once');
});

test('C13 AWAIT_RECONCILE extends the hold before every provider query', async () => {
  const store = fakeStore();
  const wallet = walletStub();
  const payout = payoutStub({ outcome: 'PENDING' }, { outcome: 'PENDING' });
  const service = new CashOutService(wallet, payout, store);

  const created = await service.create({ userId: USER, idempotencyKey: 'k13a', amount: '100222' });
  // The confirm pass issues the payout and enters AWAIT_RECONCILE without
  // reconciling, so only explicit recovery passes extend and query.
  await service.confirm(created.cashOut.id, USER, token({ paymentId: created.cashOut.id, amount: '100222' }));
  await service.drive(created.cashOut.id);
  await service.drive(created.cashOut.id);

  assert.equal(wallet.calls.extend, 2, 'each AWAIT_RECONCILE pass must extend the hold');
  assert.equal(payout.calls.query, 2);
  assert.equal(wallet.calls.release, 0, 'an UNKNOWN bank result must never release');
  assert.equal(wallet.calls.capture, 0);
  assert.equal((await rowOf(store, created.cashOut.id)).status, 'PAYOUT_PENDING');
});

test('C13 an extend failure is not terminal and the provider conclusion still settles', async () => {
  const store = fakeStore();
  const wallet = walletStub({
    // The Wallet already resolved the hold; extending it is no longer possible.
    extend: async () => { throw new DomainException(409, 'HOLD_NOT_EXTENDABLE', 'hold is gone'); },
  });
  const payout = payoutStub({ outcome: 'PENDING' }, { outcome: 'SUCCESS', bankTransactionId: 'BANK-3', failureCode: null });
  const service = new CashOutService(wallet, payout, store);

  const created = await service.create({ userId: USER, idempotencyKey: 'k13b', amount: '100222' });
  await service.confirm(created.cashOut.id, USER, token({ paymentId: created.cashOut.id, amount: '100222' }));
  assert.equal((await rowOf(store, created.cashOut.id)).status, 'PAYOUT_PENDING',
    'a failed extend must not fail the order');

  const recovered = await service.drive(created.cashOut.id);
  assert.equal(recovered!.status, 'SUCCEEDED', 'the bank SUCCESS still captures exactly once');
  assert.equal(wallet.calls.capture, 1);
  assert.equal(store.__outbox[0].eventType, 'funding.cashout_completed');
});

test('C13 bank SUCCESS but an expired hold is never reported as SUCCEEDED', async () => {
  const store = fakeStore();
  const wallet = walletStub({
    capture: async () => { throw new DomainException(409, 'HOLD_EXPIRED', 'hold expired'); },
  });
  const service = new CashOutService(wallet, payoutStub({ outcome: 'SUCCESS', bankTransactionId: 'B', failureCode: null }), store);
  const created = await service.create({ userId: USER, idempotencyKey: 'k13', amount: '100000' });

  const result = await service.confirm(created.cashOut.id, USER, token({ paymentId: created.cashOut.id }));
  assert.equal(result!.status, 'FAILED');
  assert.equal(result!.failureReason, 'RECONCILE_HOLD_EXPIRED');
  assert.notEqual(result!.status, 'SUCCEEDED', 'STOP-1: money left the bank but the hold is gone');
});

test('a worker that lost its lease cannot commit a terminal state', async () => {
  const store = fakeStore();
  const service = new CashOutService(walletStub(), payoutStub({ outcome: 'SUCCESS' }), store);
  const created = await service.create({ userId: USER, idempotencyKey: 'k14', amount: '100000' });
  // Someone else holds the lease now.
  Object.assign(store.__cashOuts.get(created.cashOut.id), { leaseToken: 'other-worker' });

  const result = await service.drive(created.cashOut.id);
  assert.equal(result!.status, 'REQUESTED', 'drive() must refuse a row leased by another worker');
  assert.equal(store.__outbox.length, 0);
});

test('amount must be a positive whole VND value', async () => {
  const service = new CashOutService(walletStub(), payoutStub({ outcome: 'SUCCESS' }), fakeStore());
  for (const amount of ['0', '-5', '1.5']) {
    await assert.rejects(
      () => service.create({ userId: USER, idempotencyKey: `bad-${amount}`, amount }),
      (error: any) => error instanceof DomainException && error.code === 'INVALID_AMOUNT',
    );
  }
});

test('C15 create() never touches the wallet', async () => {
  const store = fakeStore();
  const wallet = walletStub();
  const service = new CashOutService(wallet, payoutStub({ outcome: 'SUCCESS' }), store);
  await service.create({ userId: USER, idempotencyKey: 'k15', amount: '100000' });
  assert.equal(wallet.calls.hold, 0);
  assert.equal(wallet.calls.capture, 0);
  assert.equal(wallet.calls.release, 0);
});

test('amount comparison is Decimal-based, so 100000 equals 100000', () => {
  assert.ok(new Prisma.Decimal('100000').equals('100000'));
});
