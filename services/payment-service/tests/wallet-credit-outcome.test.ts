import assert from 'node:assert/strict';
import { test } from 'node:test';

// The IPN flow relies on distinguishing three wallet outcomes. A wrong
// classification either strands paid money (unknown read as rejected) or
// double-credits it (unknown read as success), so each branch is pinned here.

test('topupCredit classifies success, rejection and unknown outcomes', async () => {
  process.env.INTERNAL_KEY = 'synthetic-payment-wallet-credit-test-key';
  delete process.env.INTERNAL_KEY_FILE;
  const { WalletClient } = await import('../src/clients/wallet.client');
  const client = new WalletClient();
  const original = global.fetch;
  try {
    global.fetch = async () => new Response(
      JSON.stringify({ success: true, data: { transactionId: 'tx-9', replayed: false } }), { status: 200 });
    assert.deepEqual(await client.topupCredit('u', '100000.00', 'NAP1'),
      { outcome: 'success', transactionId: 'tx-9', replayed: false });

    global.fetch = async () => new Response(
      JSON.stringify({ success: true, data: { transactionId: 'tx-9', replayed: true } }), { status: 200 });
    assert.deepEqual(await client.topupCredit('u', '100000.00', 'NAP1'),
      { outcome: 'success', transactionId: 'tx-9', replayed: true });

    // Deterministic business rejection.
    global.fetch = async () => new Response(
      JSON.stringify({ success: false, error: { code: 'LIMIT_EXCEEDED', message: 'over limit' } }), { status: 422 });
    assert.deepEqual(await client.topupCredit('u', '100000.00', 'NAP1'),
      { outcome: 'rejected', status: 422, code: 'LIMIT_EXCEEDED', message: 'over limit' });

    // Retryable / genuinely unknown.
    global.fetch = async () => new Response('boom', { status: 502 });
    assert.equal((await client.topupCredit('u', '1', 'NAP1')).outcome, 'unknown');

    global.fetch = async () => new Response('', { status: 504 });
    assert.equal((await client.topupCredit('u', '1', 'NAP1')).outcome, 'unknown');

    global.fetch = async () => { throw new Error('socket hang up'); };
    assert.deepEqual(await client.topupCredit('u', '1', 'NAP1'), { outcome: 'unknown', status: null, code: null });

    // Auth misconfiguration must not be read as a business refusal.
    global.fetch = async () => new Response(
      JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'bad key' } }), { status: 403 });
    assert.equal((await client.topupCredit('u', '1', 'NAP1')).outcome, 'unknown');

    // 2xx without a transaction id is not proof the ledger moved.
    global.fetch = async () => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
    assert.equal((await client.topupCredit('u', '1', 'NAP1')).outcome, 'unknown');

    // 2xx with an unparseable body is equally unproven.
    global.fetch = async () => new Response('not-json', { status: 200 });
    assert.equal((await client.topupCredit('u', '1', 'NAP1')).outcome, 'unknown');
  } finally { global.fetch = original; }
});
