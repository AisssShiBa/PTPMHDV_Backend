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

test('K13-5: Thiếu tiền - 422 INSUFFICIENT_FUNDS, không ghi bút toán, số dư giữ nguyên', async () => {
  await seedLimitPolicies();
  const userA = await createTestWallet(500000);
  const userB = await createTestWallet(0);

  const refCapture = `hold_insufficient_${randomUUID()}`;
  const expiry = new Date(Date.now() + 60000).toISOString();

  // 1. A transfers 100k to B
  await holdService.createHold(userA.userId, '100000', refCapture, expiry, OwnerType.USER, userB.userId);
  await holdService.captureHold(userA.userId, refCapture);

  // 2. B spends 60k to SETTLEMENT
  const refSpend = `spend_${randomUUID()}`;
  await holdService.createHold(userB.userId, '60000', refSpend, expiry);
  await holdService.captureHold(userB.userId, refSpend);

  const bAfterSpend = await prisma.wallet.findUniqueOrThrow({ where: { id: userB.wallet.id } });
  assert.equal(Number(bAfterSpend.balance), 40000);

  // 3. A attempts refund of 100k (B only has 40k)
  const refRefund = `refund_${refCapture}`;
  await assert.rejects(
    async () => {
      await holdService.refundCapture(userA.userId, {
        referenceId: refRefund,
        originalReferenceId: refCapture,
        amount: '100000',
      });
    },
    (err: any) => {
      assert(err instanceof DomainException);
      assert.equal(err.code, 'INSUFFICIENT_FUNDS');
      assert.equal(err.status, 422);
      assert.equal(err.details?.available, '40000.00');
      assert.equal(err.details?.required, '100000.00');
      assert.equal(err.details?.missing, '60000.00');
      return true;
    }
  );

  // 4. Verify no ledger entry created and balances unchanged
  const bAfterFailedRefund = await prisma.wallet.findUniqueOrThrow({ where: { id: userB.wallet.id } });
  const aAfterFailedRefund = await prisma.wallet.findUniqueOrThrow({ where: { id: userA.wallet.id } });
  assert.equal(Number(bAfterFailedRefund.balance), 40000, 'User B balance must remain 40k');
  assert.equal(Number(aAfterFailedRefund.balance), 400000, 'User A balance must remain 400k');

  const ledgerRefund = await prisma.ledgerEntry.findFirst({
    where: { referenceId: refRefund },
  });
  assert.equal(ledgerRefund, null, 'No ledger entry should be created on insufficient funds');

  const holdRecord = await prisma.walletHold.findUniqueOrThrow({
    where: { sourceWalletId_referenceId: { sourceWalletId: userA.wallet.id, referenceId: refCapture } },
  });
  assert.equal(holdRecord.status, HoldStatus.CAPTURED, 'Hold status must remain CAPTURED');
});

test('K13-5: Vừa đủ tiền - hoàn thành công', async () => {
  const userA = await createTestWallet(500000);
  const userB = await createTestWallet(0);

  const refCapture = `hold_exact_${randomUUID()}`;
  const expiry = new Date(Date.now() + 60000).toISOString();

  // A transfers 100k to B (B has exactly 100k)
  await holdService.createHold(userA.userId, '100000', refCapture, expiry, OwnerType.USER, userB.userId);
  await holdService.captureHold(userA.userId, refCapture);

  // Refund 100k
  const refRefund = `refund_${refCapture}`;
  const result = await holdService.refundCapture(userA.userId, {
    referenceId: refRefund,
    originalReferenceId: refCapture,
    amount: '100000',
  });

  assert.equal(result.status, 'COMPLETED');

  const bFinal = await prisma.wallet.findUniqueOrThrow({ where: { id: userB.wallet.id } });
  const aFinal = await prisma.wallet.findUniqueOrThrow({ where: { id: userA.wallet.id } });
  assert.equal(Number(bFinal.balance), 0, 'User B balance should be exactly 0');
  assert.equal(Number(aFinal.balance), 500000, 'User A balance should be restored to 500k');
});

test('K13-5: Thiếu 1 đơn vị nhỏ nhất (0.01 VND) - bị chặn chính xác', async () => {
  const userA = await createTestWallet(500000);
  const userB = await createTestWallet(0);

  const refCapture = `hold_one_cent_${randomUUID()}`;
  const expiry = new Date(Date.now() + 60000).toISOString();

  // A transfers 100k to B
  await holdService.createHold(userA.userId, '100000', refCapture, expiry, OwnerType.USER, userB.userId);
  await holdService.captureHold(userA.userId, refCapture);

  // Manually decrement User B balance by 0.01 VND so User B has 99,999.99 VND
  await prisma.wallet.update({
    where: { id: userB.wallet.id },
    data: { balance: { decrement: 0.01 } },
  });

  const bShort = await prisma.wallet.findUniqueOrThrow({ where: { id: userB.wallet.id } });
  assert.equal(Number(bShort.balance), 99999.99);

  // Attempt refund of 100,000 VND
  const refRefund = `refund_${refCapture}`;
  await assert.rejects(
    async () => {
      await holdService.refundCapture(userA.userId, {
        referenceId: refRefund,
        originalReferenceId: refCapture,
        amount: '100000',
      });
    },
    (err: any) => {
      assert(err instanceof DomainException);
      assert.equal(err.code, 'INSUFFICIENT_FUNDS');
      assert.equal(err.status, 422);
      assert.equal(err.details?.missing, '0.01');
      return true;
    }
  );

  // Ensure balance is not negative and remains 99999.99
  const bAfter = await prisma.wallet.findUniqueOrThrow({ where: { id: userB.wallet.id } });
  assert.equal(Number(bAfter.balance), 99999.99);

  const aAfter = await prisma.wallet.findUniqueOrThrow({ where: { id: userA.wallet.id } });
  assert.equal(Number(aAfter.balance), 400000);
});
