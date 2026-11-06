import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import * as crypto from 'node:crypto';

// These tests exercise the IPN decision table without a database. The HMAC is
// computed here with an independent copy of the VNPAY canonical algorithm
// (sorted keys, encodeURIComponent, %20 -> +), so the service's own signing
// code is cross-checked rather than reused. This is a simulated callback; a
// real sandbox run is still required for formal A6 sign-off.

const SECRET = 'synthetic-vnpay-hash-secret';
const TMN = 'SYNTH_TMN_CODE';

type Row = {
  id: string;
  code: string;
  userId: string;
  amount: any;
  status: string;
  updatedAt: Date;
  vnpResponseCode?: string | null;
  walletTransactionId?: string | null;
};

function sign(params: Record<string, string>, secret = SECRET) {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(params).sort()) sorted[key] = params[key];
  const data = Object.entries(sorted)
    .map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%20/g, '+')}`)
    .join('&');
  return crypto.createHmac('sha512', secret).update(Buffer.from(data, 'utf-8')).digest('hex');
}

function fakeStore(seed: Row[]) {
  const rows = new Map<string, Row>(seed.map(r => [r.id, { ...r }]));
  const audits: any[] = [];

  const matches = (row: Row, where: any) =>
    Object.entries(where).every(([k, v]) => (row as any)[k] === v);

  const store: any = {
    __rows: rows,
    __audits: audits,
    topupRequest: {
      findUnique: async ({ where }: any) =>
        where.code
          ? [...rows.values()].find(r => r.code === where.code) ?? null
          : rows.get(where.id) ?? null,
      findMany: async ({ where }: any) =>
        [...rows.values()].filter(r =>
          Object.entries(where ?? {}).every(([k, v]: any) =>
            k === 'updatedAt' ? r.updatedAt < v.lt : (r as any)[k] === v)),
      updateMany: async ({ where, data }: any) => {
        // Prisma updateMany accepts scalars only. Rejecting nested relation
        // writes here keeps the fake honest: this exact mistake shipped once
        // and broke every approve path against a real database.
        if (data.auditLogs !== undefined) {
          throw new Error('Unknown argument `auditLogs` on updateMany');
        }
        let count = 0;
        for (const row of rows.values()) {
          if (!matches(row, where)) continue;
          count++;
          Object.assign(row, data);
        }
        return { count };
      },
      update: async ({ where, data }: any) => {
        const row = rows.get(where.id)!;
        Object.assign(row, data);
        return row;
      },
      create: async ({ data }: any) => {
        const row: Row = {
          id: crypto.randomUUID(),
          code: data.code,
          userId: data.userId,
          amount: data.amount,
          status: data.status,
          updatedAt: new Date(),
        };
        rows.set(row.id, row);
        return row;
      },
    },
    topupAuditLog: {
      create: async ({ data }: any) => {
        audits.push(data);
        return data;
      },
    },
    // Tagged-template fake. Claim updates carry 6 bind values, the recovery
    // re-claim carries 2; they are told apart by arity.
    $executeRaw: async (_strings: TemplateStringsArray, ...values: any[]) => {
      if (values.length === 6) {
        const [, , , responseCode, id, cutoff] = values;
        const row = rows.get(id);
        if (!row) return 0;
        const claimable = row.status === 'PENDING' || (row.status === 'PROCESSING' && row.updatedAt < cutoff);
        if (!claimable) return 0;
        row.status = 'PROCESSING';
        row.updatedAt = new Date();
        row.vnpResponseCode = responseCode;
        return 1;
      }
      if (values.length === 2) {
        const [id, cutoff] = values;
        const row = rows.get(id);
        if (!row || row.status !== 'PROCESSING' || row.vnpResponseCode !== '00' || !(row.updatedAt < cutoff)) return 0;
        row.updatedAt = new Date();
        return 1;
      }
      return 0;
    },
  };
  return store;
}

function ipnQuery(overrides: Record<string, string> = {}, secret = SECRET) {
  const params: Record<string, string> = {
    vnp_TmnCode: TMN,
    vnp_TxnRef: 'NAP0001',
    vnp_Amount: '10000000',
    vnp_ResponseCode: '00',
    vnp_TransactionStatus: '00',
    vnp_TransactionNo: '14123456',
    vnp_BankCode: 'NCB',
    vnp_PayDate: '20261104120000',
    ...overrides,
  };
  return { ...params, vnp_SecureHash: sign(params, secret) };
}

const baseRow = (): Row => ({
  id: '11111111-1111-4111-8111-111111111111',
  code: 'NAP0001',
  userId: '22222222-2222-4222-8222-222222222222',
  amount: new (require('@prisma/client').Prisma.Decimal)(100000),
  status: 'PENDING',
  updatedAt: new Date(Date.now() - 10 * 60 * 1000),
});

function walletSuccess(transactionId = 'tx-1', replayed = false) {
  return { topupCredit: async () => ({ outcome: 'success' as const, transactionId, replayed }) };
}

beforeEach(() => {
  process.env.VNP_HASH_SECRET = SECRET;
  process.env.VNP_TMN_CODE = TMN;
  process.env.INTERNAL_KEY = 'synthetic-payment-test-key';
});

async function loadService(deps: any) {
  const { TopupService } = await import('../src/services/topup.service');
  return new TopupService(deps);
}

test('V01 valid paid IPN with wallet success approves once and returns 00', async () => {
  const store = fakeStore([baseRow()]);
  const service = await loadService({ store, walletClient: walletSuccess() });
  const res = await service.handleVnpayIpn(ipnQuery());
  assert.equal(res.RspCode, '00');
  const row = [...store.__rows.values()][0];
  assert.equal(row.status, 'APPROVED');
  assert.equal(row.walletTransactionId, 'tx-1');
});

test('V02/V06 bad checksum and wrong TmnCode return 97 without touching the row', async () => {
  const store = fakeStore([baseRow()]);
  const service = await loadService({ store, walletClient: walletSuccess() });

  const badHash = await service.handleVnpayIpn({ ...ipnQuery(), vnp_SecureHash: 'a'.repeat(128) });
  assert.equal(badHash.RspCode, '97');

  const wrongTmn = ipnQuery({ vnp_TmnCode: 'OTHER_TMN' });
  assert.equal((await service.handleVnpayIpn(wrongTmn)).RspCode, '97');

  assert.equal([...store.__rows.values()][0].status, 'PENDING');
});

test('V07 unknown order returns 01', async () => {
  const store = fakeStore([]);
  const service = await loadService({ store, walletClient: walletSuccess() });
  assert.equal((await service.handleVnpayIpn(ipnQuery())).RspCode, '01');
});

test('V03 amount mismatch returns 04 and never credits', async () => {
  let credits = 0;
  const store = fakeStore([baseRow()]);
  const service = await loadService({
    store,
    walletClient: { topupCredit: async () => { credits++; return { outcome: 'success', transactionId: 'x', replayed: false }; } },
  });
  assert.equal((await service.handleVnpayIpn(ipnQuery({ vnp_Amount: '9999900' }))).RspCode, '04');
  assert.equal(credits, 0);
  assert.equal([...store.__rows.values()][0].status, 'PENDING');
});

test('V12 non-canonical query shapes are rejected as 97', async () => {
  const store = fakeStore([baseRow()]);
  const service = await loadService({ store, walletClient: walletSuccess() });

  const withArray = ipnQuery() as any;
  withArray.vnp_TxnRef = ['NAP0001', 'NAP0002'];
  assert.equal((await service.handleVnpayIpn(withArray)).RspCode, '97');

  const withForeign = ipnQuery() as any;
  withForeign.userId = 'attacker';
  assert.equal((await service.handleVnpayIpn(withForeign)).RspCode, '97');
});

test('already-approved order returns 02 on replay without a second credit', async () => {
  const row = baseRow();
  row.status = 'APPROVED';
  const store = fakeStore([row]);
  let credits = 0;
  const service = await loadService({
    store,
    walletClient: { topupCredit: async () => { credits++; return { outcome: 'success', transactionId: 'x', replayed: false }; } },
  });
  assert.equal((await service.handleVnpayIpn(ipnQuery())).RspCode, '02');
  assert.equal(credits, 0);
});

test('V08/A6-R unknown wallet outcome keeps PROCESSING and returns 99, recovery then approves exactly once', async () => {
  const row = baseRow();
  const store = fakeStore([row]);
  let calls = 0;
  const flaky = {
    topupCredit: async () => {
      calls++;
      if (calls === 1) return { outcome: 'unknown' as const, status: 503, code: 'WALLET_UNAVAILABLE' };
      return { outcome: 'success' as const, transactionId: 'tx-recovered', replayed: false };
    },
  };
  const service = await loadService({ store, walletClient: flaky });

  const ipn = await service.handleVnpayIpn(ipnQuery());
  assert.equal(ipn.RspCode, '99');
  assert.equal([...store.__rows.values()][0].status, 'PROCESSING', 'must not be FAILED when wallet is uncertain');

  // Simulate the lease window elapsing so the recovery worker may claim it.
  [...store.__rows.values()][0].updatedAt = new Date(Date.now() - 5 * 60 * 1000);
  const recovered = await service.recoverStuckTopups();
  assert.deepEqual(recovered, { scanned: 1, approved: 1, retried: 0 });
  assert.equal([...store.__rows.values()][0].status, 'APPROVED');
  assert.equal(calls, 2);
});

test('definitive wallet rejection stays PROCESSING and returns 99 (money never marked failed)', async () => {
  const store = fakeStore([baseRow()]);
  const service = await loadService({
    store,
    walletClient: { topupCredit: async () => ({ outcome: 'rejected' as const, status: 422, code: 'LIMIT_EXCEEDED', message: 'limit' }) },
  });
  const res = await service.handleVnpayIpn(ipnQuery());
  assert.equal(res.RspCode, '99');
  const row = [...store.__rows.values()][0];
  assert.equal(row.status, 'PROCESSING');
  assert.ok(store.__audits.some((a: any) => a.action === 'WALLET_CREDIT_REJECTED'));
});

test('wallet transport throw is unknown, not failure', async () => {
  const store = fakeStore([baseRow()]);
  const service = await loadService({
    store,
    walletClient: { topupCredit: async () => { throw new Error('ECONNRESET'); } },
  });
  assert.equal((await service.handleVnpayIpn(ipnQuery())).RspCode, '99');
  assert.equal([...store.__rows.values()][0].status, 'PROCESSING');
});

test('V05 non-paid VNPAY result marks FAILED and returns 00, without crediting', async () => {
  let credits = 0;
  const store = fakeStore([baseRow()]);
  const service = await loadService({
    store,
    walletClient: { topupCredit: async () => { credits++; return { outcome: 'success', transactionId: 'x', replayed: false }; } },
  });
  const query = ipnQuery({ vnp_ResponseCode: '24', vnp_TransactionStatus: '02' });
  assert.equal((await service.handleVnpayIpn(query)).RspCode, '00');
  assert.equal([...store.__rows.values()][0].status, 'FAILED');
  assert.equal(credits, 0);
});

test('V09 crash between wallet credit and status update: recovery replays the same reference once', async () => {
  const row = baseRow();
  row.status = 'PROCESSING';
  row.vnpResponseCode = '00';
  row.updatedAt = new Date(Date.now() - 10 * 60 * 1000);
  const store = fakeStore([row]);

  const seenRefs: string[] = [];
  const service = await loadService({
    store,
    walletClient: {
      topupCredit: async (_u: string, _a: string, ref: string) => {
        seenRefs.push(ref);
        // Wallet already applied the first credit, so it replays.
        return { outcome: 'success' as const, transactionId: 'tx-original', replayed: true };
      },
    },
  });

  const result = await service.recoverStuckTopups();
  assert.equal(result.approved, 1);
  assert.deepEqual(seenRefs, ['NAP0001'], 'recovery must reuse topup.code, never a new reference');
  assert.equal([...store.__rows.values()][0].status, 'APPROVED');
});

test('return URL is read-only and rejects a forged signature', async () => {
  const store = fakeStore([baseRow()]);
  const service = await loadService({ store, walletClient: walletSuccess() });
  const ok = await service.handleVnpayReturn(ipnQuery());
  assert.equal(ok.vnp_TxnRef, 'NAP0001');
  assert.equal([...store.__rows.values()][0].status, 'PENDING');

  await assert.rejects(
    service.handleVnpayReturn({ ...ipnQuery(), vnp_SecureHash: 'b'.repeat(128) }),
    (err: any) => err.status === 400 && err.code === 'INVALID_SIGNATURE'
  );
});
