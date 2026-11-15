import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import {
  getWalletPrisma,
  getFinancialSnapshot,
  checkSystemConservation,
  verifyDeltaConservation,
  resetToSeed,
  loginSeed,
  getPinTransactionToken,
  apiCall,
  createK20Logger
} from './k20-shared.mjs';

describe('K20-1: Shared Acceptance Framework & Invariants Self-Test', () => {
  const prisma = getWalletPrisma();
  const logger = createK20Logger('SELFTEST-FRAMEWORK');

  after(async () => {
    await prisma.$disconnect();
  });

  test('Test 1: resetToSeed đưa hệ thống về đúng seed accounts, tiers, balances và bảo toàn = 0', async () => {
    logger.section('Test 1: resetToSeed baseline');
    const { accounts, targets, conservation } = await resetToSeed({ forScenario: 'DEFAULT' });

    assert.ok(accounts.admin.userId, 'Admin user phải tồn tại');
    assert.ok(accounts.an.userId, 'An user phải tồn tại');
    assert.ok(accounts.binh.userId, 'Binh user phải tồn tại');
    assert.ok(accounts.chi.userId, 'Chi user phải tồn tại');

    // Kiểm tra số dư từng ví
    const anWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: accounts.an.walletId } });
    const binhWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: accounts.binh.walletId } });
    const chiWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: accounts.chi.walletId } });

    assert.equal(Number(anWallet.balance), 1250000, 'Số dư An = 1.250.000 VND');
    assert.equal(Number(binhWallet.balance), 300000, 'Số dư Binh = 300.000 VND');
    assert.equal(Number(chiWallet.balance), 100000, 'Số dư Chi = 100.000 VND');

    // Kiểm tra kycTier
    assert.equal(anWallet.kycTier, 2, 'An kycTier = 2');
    assert.equal(binhWallet.kycTier, 1, 'Binh kycTier = 1');
    assert.equal(chiWallet.kycTier, 0, 'Chi kycTier = 0');

    // Kiểm tra conservation
    assert.equal(conservation.passed, true, 'Bảo toàn tiền phải đạt');
    assert.equal(conservation.snapshot.totalBalance, 0, 'Tổng số dư hệ thống phải bằng 0');
    logger.result(true, 'Test 1 PASS: resetToSeed hoạt động chính xác!');
  });

  test('Test 2: checkSystemConservation phát hiện lệch số dư cố ý (Intentional Drift)', async () => {
    logger.section('Test 2: Intentional Drift Detection');
    const { accounts } = await resetToSeed({ forScenario: 'DEFAULT' });

    const beforeSnap = await getFinancialSnapshot(prisma);
    assert.equal(beforeSnap.totalBalance, 0, 'Số dư trước drift = 0');

    // Cố ý làm lệch số dư ví Binh thêm +50.000đ trực tiếp qua DB
    await prisma.wallet.update({
      where: { id: accounts.binh.walletId },
      data: { balance: { increment: 50000 } }
    });

    const driftConservation = await checkSystemConservation(prisma);
    assert.equal(driftConservation.passed, false, 'checkSystemConservation phải phát hiện KHÔNG ĐẠT khi có drift');
    assert.equal(driftConservation.snapshot.totalBalance, 50000, 'Tổng số dư phải lệch đúng +50.000 VND');
    assert.ok(driftConservation.errors.some(e => e.includes('Tổng số dư hệ thống khác 0')), 'Phải có lỗi tổng số dư');

    // Khôi phục lại đúng số dư
    await prisma.wallet.update({
      where: { id: accounts.binh.walletId },
      data: { balance: { decrement: 50000 } }
    });

    const restoredConservation = await checkSystemConservation(prisma);
    assert.equal(restoredConservation.passed, true, 'Sau khi khôi phục, bảo toàn phải PASS');
    assert.equal(restoredConservation.snapshot.totalBalance, 0, 'Số dư sau khôi phục = 0');
    logger.result(true, 'Test 2 PASS: Phát hiện lệch cố ý hoàn hảo!');
  });

  test('Test 3: verifyDeltaConservation phát hiện chênh lệch giữa hai thời điểm', async () => {
    logger.section('Test 3: Delta Conservation');
    const snap1 = {
      totalBalance: 0,
      totalCredit: 1000000,
      totalDebit: 1000000
    };
    const snap2 = {
      totalBalance: 0,
      totalCredit: 1060000,
      totalDebit: 1060000
    };
    const snap3Invalid = {
      totalBalance: 20000,
      totalCredit: 1060000,
      totalDebit: 1040000
    };

    const deltaValid = verifyDeltaConservation(snap1, snap2);
    assert.equal(deltaValid.passed, true, 'Delta hợp lệ phải PASS');
    assert.equal(deltaValid.deltaBalance, 0);

    const deltaInvalid = verifyDeltaConservation(snap1, snap3Invalid);
    assert.equal(deltaInvalid.passed, false, 'Delta không cân bằng phải FAIL');
    logger.result(true, 'Test 3 PASS: verifyDeltaConservation hoạt động chính xác!');
  });

  test('Test 4: Luồng lấy PIN transactionToken thật qua Gateway', async () => {
    logger.section('Test 4: PIN verify token flow');
    const { accounts } = await resetToSeed();
    const token = await getPinTransactionToken(accounts.an.token, 'test-pay-k20', '60000');
    assert.ok(token, 'transactionToken phải tồn tại');
    assert.ok(typeof token === 'string' && token.split('.').length === 3, 'Phải là JWT ES256');
    logger.result(true, 'Test 4 PASS: Lấy transactionToken thật qua Gateway thành công!');
  });
});
