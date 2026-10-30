import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Wallet errors preserve limit metadata and transport failures remain retryable', async () => {
  process.env.INTERNAL_KEY = 'synthetic-payment-wallet-client-test-key';
  delete process.env.INTERNAL_KEY_FILE;
  const { WalletClient } = await import('../src/clients/wallet.client');
  const original = global.fetch;
  const client = new WalletClient();
  try {
    global.fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      assert.equal(body.destinationUserId, 'receiver');
      return new Response(JSON.stringify({ error: { code: 'LIMIT_EXCEEDED', message: 'limit', limitType: 'PER_DAY', remaining: '0' } }), { status: 422 });
    };
    await assert.rejects(client.createHold('sender', '1000', 'reference', 'expiry', 'receiver'),
      (error: any) => error.status === 422 && error.code === 'LIMIT_EXCEEDED' && error.details.limitType === 'PER_DAY');
    global.fetch = async () => { throw new Error('lost response'); };
    await assert.rejects(client.captureHold('sender', 'reference'), { status: 503, code: 'WALLET_UNAVAILABLE' });
    await assert.rejects(client.releaseHold('sender', 'reference'), { status: 503, code: 'WALLET_UNAVAILABLE' });
  } finally { global.fetch = original; }
});
