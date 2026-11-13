import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient, OwnerType, HoldStatus, TransferType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { LedgerService } from '../src/services/ledger.service';
import { WalletHoldService } from '../src/services/wallet-hold.service';
import { LimitService } from '../src/services/limit.service';
import { DomainException } from '../src/utils/domain.exception';
import { seedLimitPolicies } from '../prisma/seed';

const prisma = new PrismaClient();
const ledgerService = new LedgerService();
const limitService = new LimitService();
const holdService = new WalletHoldService(ledgerService, limitService);

async function createTestWallet(balance: number, kycTier = 2) {
  const userId = randomUUID();
  const wallet = await prisma.wallet.create({
    data: {
      userId,
      balance,
      heldBalance: 0,
      currency: 'VND',
      ownerType: OwnerType.USER,
      kycTier,
    },
  });
  return { userId, wallet };
}

async function getSystemTotalBalance(): Promise<number> {
  const wallets = await prisma.wallet.findMany({ select: { balance: true } });
  return wallets.reduce((acc, w) => acc + Number(w.balance), 0);
}

test('K13-6: Lũy đẳng - gọi lại cùng referenceId trả đúng kết quả lần đầu, không ghi thêm bút toán', async () => {
  await seedLimitPolicies();
  const userA = await createTestWallet(500000);
  const userB = await createTestWallet(100000);

  const refCapture = `hold_idem_${randomUUID()}`;
  const expiry = new Date(Date.now() + 60000).toISOString();

  await holdService.createHold(userA.userId, '100000', refCapture, expiry, OwnerType.USER, userB.userId);
  await holdService.captureHold(userA.userId, refCapture);

  const refRefund = `refund_${refCapture}`;

  // Call 1
  const res1 = await holdService.refundCapture(userA.userId, {
    referenceId: refRefund,
    originalReferenceId: refCapture,
    amount: '100000',
  });
  assert.equal(res1.status, 'COMPLETED');
  assert.equal(res1.replayed, false);
  assert.ok(res1.transactionId);

  // Call 2 (identical)
  const res2 = await holdService.refundCapture(userA.userId, {
    referenceId: refRefund,
    originalReferenceId: refCapture,
    amount: '100000',
  });
  assert.equal(res2.status, 'COMPLETED');
  assert.equal(res2.replayed, true);
  assert.equal(res2.transactionId, res1.transactionId, 'Replayed call must return identical transactionId');

  // Verify only 1 refund ledger entry exists for User B and User A
  const debitEntries = await prisma.ledgerEntry.findMany({
    where: { walletId: userB.wallet.id, referenceId: refRefund },
  });
  assert.equal(debitEntries.length, 1, 'Exactly 1 debit entry for User B');

  const creditEntries = await prisma.ledgerEntry.findMany({
    where: { walletId: userA.wallet.id, referenceId: refRefund },
  });
  assert.equal(creditEntries.length, 1, 'Exactly 1 credit entry for User A');
});

test('K13-6: REFERENCE_ID_REUSED khi dùng lại referenceId cho hold khác hoặc sai số tiền', async () => {
  const userA = await createTestWallet(500000);
  const userB = await createTestWallet(100000);

  const refCapture1 = `hold_reuse_1_${randomUUID()}`;
  const refCapture2 = `hold_reuse_2_${randomUUID()}`;
  const expiry = new Date(Date.now() + 60000).toISOString();

  await holdService.createHold(userA.userId, '100000', refCapture1, expiry, OwnerType.USER, userB.userId);
  await holdService.captureHold(userA.userId, refCapture1);

  await holdService.createHold(userA.userId, '50000', refCapture2, expiry, OwnerType.USER, userB.userId);
  await holdService.captureHold(userA.userId, refCapture2);

  const sharedRefundRef = `refund_shared_${randomUUID()}`;

  // Refund hold 1 successfully
  await holdService.refundCapture(userA.userId, {
    referenceId: sharedRefundRef,
    originalReferenceId: refCapture1,
    amount: '100000',
  });

  // Reusing same sharedRefundRef for hold 2 -> REFERENCE_ID_REUSED
  await assert.rejects(
    async () => {
      await holdService.refundCapture(userA.userId, {
        referenceId: sharedRefundRef,
        originalReferenceId: refCapture2,
        amount: '50000',
      });
    },
    (err: any) => {
      assert(err instanceof DomainException);
      assert.equal(err.code, 'REFERENCE_ID_REUSED');
      assert.equal(err.status, 409);
      return true;
    }
  );
});

test('K13-6: ALREADY_REFUNDED khi hoàn một capture đã hoàn bằng referenceId khác', async () => {
  const userA = await createTestWallet(500000);
  const userB = await createTestWallet(100000);

  const refCapture = `hold_double_${randomUUID()}`;
  const expiry = new Date(Date.now() + 60000).toISOString();

  await holdService.createHold(userA.userId, '100000', refCapture, expiry, OwnerType.USER, userB.userId);
  await holdService.captureHold(userA.userId, refCapture);

  // Refund first time with ref_1
  const refRefund1 = `refund_first_${randomUUID()}`;
  await holdService.refundCapture(userA.userId, {
    referenceId: refRefund1,
    originalReferenceId: refCapture,
    amount: '100000',
  });

  // Try to refund same capture with different referenceId ref_2 -> ALREADY_REFUNDED
  const refRefund2 = `refund_second_${randomUUID()}`;
  await assert.rejects(
    async () => {
      await holdService.refundCapture(userA.userId, {
        referenceId: refRefund2,
        originalReferenceId: refCapture,
        amount: '100000',
      });
    },
    (err: any) => {
      assert(err instanceof DomainException);
      assert.equal(err.code, 'ALREADY_REFUNDED');
      assert.equal(err.status, 409);
      return true;
    }
  );
});

test('K13-6: Hai request song song cùng referenceId -> đúng một bút toán', async () => {
  const userA = await createTestWallet(500000);
  const userB = await createTestWallet(100000);

  const initialTotal = Number(userA.wallet.balance) + Number(userB.wallet.balance);

  const refCapture = `hold_parallel_${randomUUID()}`;
  const expiry = new Date(Date.now() + 60000).toISOString();

  await holdService.createHold(userA.userId, '100000', refCapture, expiry, OwnerType.USER, userB.userId);
  await holdService.captureHold(userA.userId, refCapture);

  const refRefund = `refund_parallel_${randomUUID()}`;

  // Launch 2 parallel refund calls with identical referenceId
  const [res1, res2] = await Promise.all([
    holdService.refundCapture(userA.userId, {
      referenceId: refRefund,
      originalReferenceId: refCapture,
      amount: '100000',
    }),
    holdService.refundCapture(userA.userId, {
      referenceId: refRefund,
      originalReferenceId: refCapture,
      amount: '100000',
    }),
  ]);

  // Both should succeed and share the same transactionId
  assert.equal(res1.status, 'COMPLETED');
  assert.equal(res2.status, 'COMPLETED');
  assert.equal(res1.transactionId, res2.transactionId);

  // Exactly 1 debit and 1 credit entry
  const debitEntries = await prisma.ledgerEntry.findMany({
    where: { walletId: userB.wallet.id, referenceId: refRefund },
  });
  assert.equal(debitEntries.length, 1);

  // Balances
  const aFinal = await prisma.wallet.findUniqueOrThrow({ where: { id: userA.wallet.id } });
  const bFinal = await prisma.wallet.findUniqueOrThrow({ where: { id: userB.wallet.id } });
  assert.equal(Number(aFinal.balance), 500000);
  assert.equal(Number(bFinal.balance), 100000);

  const finalTotal = Number(aFinal.balance) + Number(bFinal.balance);
  assert.equal(finalTotal, initialTotal, 'Participant wallets balance conservation sum = 0');
});

test('K13-6: Tra cứu theo referenceId - cả trường hợp đã ghi và chưa ghi', async () => {
  const nonExistentRef = `non_existent_${randomUUID()}`;

  // 1. Service lookup when not exists
  const lookupNotExists = await ledgerService.lookupByReferenceId(nonExistentRef);
  assert.equal(lookupNotExists.exists, false);

  // 2. Perform a refund
  const userA = await createTestWallet(300000);
  const refCapture = `hold_lookup_${randomUUID()}`;
  const expiry = new Date(Date.now() + 60000).toISOString();
  await holdService.createHold(userA.userId, '80000', refCapture, expiry);
  await holdService.captureHold(userA.userId, refCapture);

  const refRefund = `refund_lookup_${randomUUID()}`;
  const refundRes = await holdService.refundCapture(userA.userId, {
    referenceId: refRefund,
    originalReferenceId: refCapture,
    amount: '80000',
  });

  // 3. Service lookup when exists
  const lookupExists = await ledgerService.lookupByReferenceId(refRefund);
  assert.equal(lookupExists.exists, true);
  if (lookupExists.exists) {
    assert.equal(lookupExists.transactionId, refundRes.transactionId);
    assert.equal(lookupExists.referenceId, refRefund);
    assert.equal(lookupExists.status, 'COMPLETED');
    assert.equal(lookupExists.amount, '80000.00');
  }

  // 4. HTTP endpoint lookup via Express app
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const internalKey = process.env.INTERNAL_KEY || 'default_test_key';
  process.env.INTERNAL_KEY = internalKey;

  try {
    // HTTP lookup not exists
    const resHttpNotExists = await fetch(`${baseUrl}/api/wallets/transactions/lookup?referenceId=${nonExistentRef}`, {
      headers: { 'x-internal-key': internalKey },
    });
    assert.equal(resHttpNotExists.status, 200);
    const jsonNotExists = await resHttpNotExists.json();
    assert.equal(jsonNotExists.success, true);
    assert.equal(jsonNotExists.data.exists, false);

    // HTTP lookup exists
    const resHttpExists = await fetch(`${baseUrl}/api/wallets/transactions/lookup?referenceId=${refRefund}`, {
      headers: { 'x-internal-key': internalKey },
    });
    assert.equal(resHttpExists.status, 200);
    const jsonExists = await resHttpExists.json();
    assert.equal(jsonExists.success, true);
    assert.equal(jsonExists.data.exists, true);
    assert.equal(jsonExists.data.transactionId, refundRes.transactionId);
    assert.equal(jsonExists.data.referenceId, refRefund);
    assert.equal(jsonExists.data.amount, '80000.00');
  } finally {
    server.close();
  }
});
