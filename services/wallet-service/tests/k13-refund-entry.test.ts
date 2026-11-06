import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient, OwnerType, HoldStatus, TransferType, SystemWalletCode } from '@prisma/client';
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

test('K13-4: P2P refund reverses money from destination to source correctly', async () => {
  await seedLimitPolicies();
  const userA = await createTestWallet(500000);
  const userB = await createTestWallet(100000);

  const initialTotal = Number(userA.wallet.balance) + Number(userB.wallet.balance);

  const refCapture = `test_p2p_hold_${randomUUID()}`;
  const expiry = new Date(Date.now() + 60000).toISOString();

  // 1. Hold and Capture User A -> User B
  await holdService.createHold(userA.userId, '200000', refCapture, expiry, OwnerType.USER, userB.userId);
  await holdService.captureHold(userA.userId, refCapture);

  const userAAfterCapture = await prisma.wallet.findUniqueOrThrow({ where: { id: userA.wallet.id } });
  const userBAfterCapture = await prisma.wallet.findUniqueOrThrow({ where: { id: userB.wallet.id } });
  assert.equal(Number(userAAfterCapture.balance), 300000);
  assert.equal(Number(userBAfterCapture.balance), 300000);

  // 2. Refund User A <- User B
  const refRefund = `refund_${refCapture}`;
  const refundResult = await holdService.refundCapture(userA.userId, {
    referenceId: refRefund,
    originalReferenceId: refCapture,
    amount: '200000',
  });

  assert.equal(refundResult.status, 'COMPLETED');
  assert.equal(refundResult.referenceId, refRefund);
  assert.equal(refundResult.amount, '200000.00');

  // Verify wallet balances after refund
  const userAAfterRefund = await prisma.wallet.findUniqueOrThrow({ where: { id: userA.wallet.id } });
  const userBAfterRefund = await prisma.wallet.findUniqueOrThrow({ where: { id: userB.wallet.id } });
  assert.equal(Number(userAAfterRefund.balance), 500000, 'Source wallet should have balance restored to 500k');
  assert.equal(Number(userBAfterRefund.balance), 100000, 'Destination wallet balance should be debited back to 100k');

  // Verify LedgerEntry
  const debitEntry = await prisma.ledgerEntry.findUniqueOrThrow({
    where: { walletId_referenceId: { walletId: userB.wallet.id, referenceId: refRefund } },
  });
  assert.equal(debitEntry.direction, 'DEBIT');
  assert.equal(debitEntry.transferType, TransferType.REFUND);
  assert.equal(Number(debitEntry.amount), 200000);

  const creditEntry = await prisma.ledgerEntry.findUniqueOrThrow({
    where: { walletId_referenceId: { walletId: userA.wallet.id, referenceId: refRefund } },
  });
  assert.equal(creditEntry.direction, 'CREDIT');
  assert.equal(creditEntry.transferType, TransferType.REFUND);
  assert.equal(Number(creditEntry.amount), 200000);
  assert.equal(debitEntry.transactionId, creditEntry.transactionId);

  // Verify total system balance is unchanged
  const finalTotal = Number(userAAfterRefund.balance) + Number(userBAfterRefund.balance);
  assert.equal(finalTotal, initialTotal, 'Participant wallets total balance must be conserved');
});

test('K13-4: Non-P2P refund reverses money from SETTLEMENT to source correctly', async () => {
  const userC = await createTestWallet(300000);

  const refCapture = `test_nonp2p_hold_${randomUUID()}`;
  const expiry = new Date(Date.now() + 60000).toISOString();

  // 1. Hold and Capture User C -> SETTLEMENT
  await holdService.createHold(userC.userId, '100000', refCapture, expiry);
  await holdService.captureHold(userC.userId, refCapture);

  const userCAfterCapture = await prisma.wallet.findUniqueOrThrow({ where: { id: userC.wallet.id } });
  assert.equal(Number(userCAfterCapture.balance), 200000);

  // 2. Refund User C <- SETTLEMENT
  const refRefund = `refund_${refCapture}`;
  const refundResult = await holdService.refundCapture(userC.userId, {
    referenceId: refRefund,
    originalReferenceId: refCapture,
    amount: '100000',
  });

  assert.equal(refundResult.status, 'COMPLETED');

  const userCAfterRefund = await prisma.wallet.findUniqueOrThrow({ where: { id: userC.wallet.id } });
  assert.equal(Number(userCAfterRefund.balance), 300000, 'Source wallet should have balance restored to 300k');

  const settlementWallet = await prisma.wallet.findUniqueOrThrow({
    where: { systemCode: SystemWalletCode.SETTLEMENT },
  });

  const debitEntry = await prisma.ledgerEntry.findUniqueOrThrow({
    where: { walletId_referenceId: { walletId: settlementWallet.id, referenceId: refRefund } },
  });
  assert.equal(debitEntry.direction, 'DEBIT');
  assert.equal(debitEntry.transferType, TransferType.REFUND);

  const creditEntry = await prisma.ledgerEntry.findUniqueOrThrow({
    where: { walletId_referenceId: { walletId: userC.wallet.id, referenceId: refRefund } },
  });
  assert.equal(creditEntry.direction, 'CREDIT');
  assert.equal(creditEntry.transferType, TransferType.REFUND);

  assert.equal(debitEntry.transactionId, creditEntry.transactionId);
  assert.equal(Number(debitEntry.amount), Number(creditEntry.amount), 'Debit must equal Credit in double-entry');
  assert.equal(Number(userCAfterRefund.balance), Number(userC.wallet.balance), 'User wallet balance fully restored');
});

test('K13-4: Refund throws CAPTURE_NOT_FOUND when capture does not exist or was not captured', async () => {
  const userD = await createTestWallet(200000);

  // Non-existent capture
  await assert.rejects(
    async () => {
      await holdService.refundCapture(userD.userId, {
        referenceId: `refund_${randomUUID()}`,
        originalReferenceId: `non_existent_${randomUUID()}`,
        amount: '50000',
      });
    },
    (err: any) => {
      assert(err instanceof DomainException);
      assert.equal(err.code, 'CAPTURE_NOT_FOUND');
      assert.equal(err.status, 404);
      return true;
    }
  );

  // Hold exists but was released (not captured)
  const refReleased = `released_hold_${randomUUID()}`;
  const expiry = new Date(Date.now() + 60000).toISOString();
  await holdService.createHold(userD.userId, '50000', refReleased, expiry);
  await holdService.releaseHold(userD.userId, refReleased);

  await assert.rejects(
    async () => {
      await holdService.refundCapture(userD.userId, {
        referenceId: `refund_${randomUUID()}`,
        originalReferenceId: refReleased,
        amount: '50000',
      });
    },
    (err: any) => {
      assert(err instanceof DomainException);
      assert.equal(err.code, 'CAPTURE_NOT_FOUND');
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test('K13-4: Refund throws AMOUNT_MISMATCH when refund amount is not equal to captured amount', async () => {
  const userE = await createTestWallet(300000);
  const refCapture = `test_mismatch_${randomUUID()}`;
  const expiry = new Date(Date.now() + 60000).toISOString();

  await holdService.createHold(userE.userId, '150000', refCapture, expiry);
  await holdService.captureHold(userE.userId, refCapture);

  // Try partial refund
  await assert.rejects(
    async () => {
      await holdService.refundCapture(userE.userId, {
        referenceId: `refund_${randomUUID()}`,
        originalReferenceId: refCapture,
        amount: '100000',
      });
    },
    (err: any) => {
      assert(err instanceof DomainException);
      assert.equal(err.code, 'AMOUNT_MISMATCH');
      assert.equal(err.status, 422);
      return true;
    }
  );

  // Try excess refund
  await assert.rejects(
    async () => {
      await holdService.refundCapture(userE.userId, {
        referenceId: `refund_${randomUUID()}`,
        originalReferenceId: refCapture,
        amount: '200000',
      });
    },
    (err: any) => {
      assert(err instanceof DomainException);
      assert.equal(err.code, 'AMOUNT_MISMATCH');
      assert.equal(err.status, 422);
      return true;
    }
  );
});

test('K13-4: Endpoint refund enforces INTERNAL or ADMIN permission (user gets 403)', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const dummyUserId = randomUUID();

    // 1. Request with no auth -> 401 Unauthorized
    const resNoAuth = await fetch(`${baseUrl}/api/wallets/${dummyUserId}/refund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        referenceId: 'ref_1',
        originalReferenceId: 'orig_1',
        amount: '10000.00',
      }),
    });
    assert.equal(resNoAuth.status, 401);

    // 2. Request with internal key -> reaches controller (returns 404 WALLET_NOT_FOUND since dummyUserId doesn't exist)
    const internalKey = process.env.INTERNAL_KEY || 'default_test_key';
    process.env.INTERNAL_KEY = internalKey;

    const resInternal = await fetch(`${baseUrl}/api/wallets/${dummyUserId}/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': internalKey,
      },
      body: JSON.stringify({
        referenceId: 'ref_1',
        originalReferenceId: 'orig_1',
        amount: '10000.00',
      }),
    });
    // It passed auth middleware and failed at business logic (404)
    assert.equal(resInternal.status, 404);
    const body = await resInternal.json();
    assert.equal(body.error?.code, 'WALLET_NOT_FOUND');
  } finally {
    server.close();
  }
});
