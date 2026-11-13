import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { createTopupSchema } from '../src/validations/topup.validation';

test('topup accepts canonical string VND and bounded legacy integers, rejects malformed money and keys', () => {
  for (const amount of ['10000', '100000000', 10000]) {
    assert.equal(createTopupSchema.parse({ body: { amount }, headers: {} }).body.amount, String(amount));
  }
  for (const amount of ['9999', '100000001', '1e5', '10000.0', '010000', ' 10000', 'NaN', 10000.5, -10000]) {
    assert.equal(createTopupSchema.safeParse({ body: { amount }, headers: {} }).success, false);
  }
  assert.equal(createTopupSchema.safeParse({ body: { amount: '10000' }, headers: { 'idempotency-key': 'invalid' } }).success, false);
});

test('concurrent topup retries persist one complete URL; keys bind owner and amount', async () => {
  process.env.VNP_TMN_CODE = 'SYNTH_TMN_CODE';
  process.env.VNP_HASH_SECRET = 'synthetic-test-only';
  process.env.VNP_URL = 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html';
  process.env.VNP_RETURN_URL = 'http://localhost/return';
  process.env.INTERNAL_KEY = 'synthetic-test-only';
  const { TopupService } = await import('../src/services/topup.service');
  const rows = new Map<string, any>();
  const store: any = {
    topupRequest: {
      findUnique: async ({ where }: any) => rows.get(JSON.stringify(where.userId_idempotencyKey)) ?? null,
      create: async ({ data }: any) => {
        const key = JSON.stringify({ userId: data.userId, idempotencyKey: data.idempotencyKey });
        if (rows.has(key)) throw Object.assign(new Error('unique conflict'), { code: 'P2002' });
        const row = { ...data, id: randomUUID(), amount: new Prisma.Decimal(data.amount) };
        assert.match(row.paymentUrl, /vnp_SecureHash=/);
        rows.set(key, row);
        return row;
      },
    },
  };
  const service = new TopupService({ store });
  const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 20 }, () => service.createTopup('owner-A', '10000', '127.0.0.1', key)));
  assert.equal(new Set(results.map(result => result.topupId)).size, 1);
  assert.equal(new Set(results.map(result => result.paymentUrl)).size, 1);
  assert.equal(rows.size, 1);
  assert.deepEqual(await service.createTopup('owner-A', '10000', '127.0.0.2', key), results[0]);
  await assert.rejects(service.createTopup('owner-A', '20000', '127.0.0.1', key), (error: any) => error.code === 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
  const other = await service.createTopup('owner-B', '10000', '127.0.0.1', key);
  assert.notEqual(other.topupId, results[0].topupId);
  assert.equal(rows.size, 2);
});
