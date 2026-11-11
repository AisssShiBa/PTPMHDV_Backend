/**
 * KỊCH BẢN NGHIỆM THU A9: HẠN MỨC GIAO DỊCH CẤP 0 (chi@demo.vn)
 * Định nghĩa ĐÚNG:
 * - chi@demo.vn (Cấp 0), nạp thêm 1.000.000đ, chuyển 600.000đ.
 *   ĐÚNG: 422 LIMIT_EXCEEDED, limitType PER_TXN, số dư và usage không đổi.
 * - Biến thể 3 x 200.000đ -> lần 1 và 2 thành công, lần 3 bị từ chối với limitType PER_DAY, remaining đúng.
 * - Kiểm tra bảo toàn tiền trước và sau.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createK20Logger,
  resetToSeed,
  loginSeed,
  apiCall,
  getFinancialSnapshot,
  checkSystemConservation,
  verifyDeltaConservation,
  getPinTransactionToken,
  getWalletPrisma
} from './k20-shared.mjs';

export async function runA9() {
  const logger = createK20Logger('A9');
  logger.section('BẮT ĐẦU KỊCH BẢN NGHIỆM THU A9: HẠN MỨC CẤP 0');

  const prisma = getWalletPrisma();

  // 1. Reset về seed sạch
  logger.info('Bước 1: Reset môi trường về trạng thái seed sạch (Chi khởi đầu 100.000đ, Tier 0)');
  const { accounts, conservation: initialConservation } = await resetToSeed({ forScenario: 'DEFAULT' });
  assert.equal(initialConservation.passed, true, 'Bảo toàn seed ban đầu phải đạt');

  const chiWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: accounts.chi.walletId } });
  assert.equal(chiWallet.kycTier, 0, 'Chi phải là KYC Tier 0');
  assert.equal(Number(chiWallet.balance), 100000, 'Số dư khởi điểm của Chi = 100.000đ');

  // Nạp thêm 1.000.000đ cho Chi qua luồng Admin credit
  logger.info('Bước 2: Nạp thêm 1.000.000đ vào ví Chi qua API Admin credit');
  const topupRes = await apiCall(`/wallets/${accounts.chi.userId}/credit`, {
    method: 'POST',
    token: accounts.admin.token,
    body: {
      amount: '1000000',
      referenceId: `topup-chi-a9-${randomUUID()}`,
      transferType: 'TOPUP'
    },
    expected: 200
  });

  const chiWalletAfterTopup = await prisma.wallet.findUniqueOrThrow({ where: { id: accounts.chi.walletId } });
  assert.equal(Number(chiWalletAfterTopup.balance), 1100000, 'Số dư ví Chi sau nạp phải đúng 1.100.000đ');
  logger.info(`Nạp tiền thành công! Số dư hiện tại của Chi = ${Number(chiWalletAfterTopup.balance).toLocaleString()} VND`);

  const snapshotBefore = await getFinancialSnapshot(prisma);
  logger.info(`Snapshot tài chính TRƯỚC: TotalBalance=${snapshotBefore.totalBalance}, TotalDebit=${snapshotBefore.totalDebit}, TotalCredit=${snapshotBefore.totalCredit}`);

  let branchPerTxnPassed = false;
  let branchPerDayPassed = false;

  try {
    // --------------------------------------------------------------------------
    // NHÁNH 1: Chuyển 600.000đ (Vượt hạn mức một lần: 200.000đ)
    // --------------------------------------------------------------------------
    logger.section('NHÁNH 1: Chuyển 600.000đ một lần (Hạn mức PER_TXN = 200.000đ)');
    const keyTxn1 = `a9-per-txn-${randomUUID()}`;

    const resOverTxn = await apiCall('/payments/p2p/checkout', {
      method: 'POST',
      token: accounts.chi.token,
      headers: { 'Idempotency-Key': keyTxn1 },
      body: {
        destinationUserId: accounts.binh.userId,
        amount: '600000'
      }
    });

    logger.info(`Kết quả chuyển 600k: status=${resOverTxn.status}, code=${resOverTxn.data?.error?.code}, limitType=${resOverTxn.data?.error?.details?.limitType}`);
    assert.equal(resOverTxn.status, 422, 'Phải trả về HTTP 422 khi vượt hạn mức');
    assert.equal(resOverTxn.data?.error?.code, 'LIMIT_EXCEEDED', 'Mã lỗi phải là LIMIT_EXCEEDED');
    assert.equal(resOverTxn.data?.error?.details?.limitType, 'PER_TXN', 'limitType phải là PER_TXN');

    // Kiểm tra số dư và usage KHÔNG đổi
    const chiWalletAfterReject = await prisma.wallet.findUniqueOrThrow({ where: { id: accounts.chi.walletId } });
    const usageRow = await prisma.userDailyUsage.findFirst({ where: { userId: accounts.chi.userId } });

    assert.equal(Number(chiWalletAfterReject.balance), 1100000, 'Số dư ví Chi KHÔNG ĐƯỢC THAY ĐỔI sau khi bị từ chối');
    assert.equal(Number(chiWalletAfterReject.heldBalance), 0, 'Held balance ví Chi phải = 0');
    assert.equal(Number(usageRow?.spentDay || 0), 0, 'UserDailyUsage KHÔNG ĐƯỢC THAY ĐỔI sau khi bị từ chối');

    branchPerTxnPassed = true;
    logger.result(true, 'ĐẠT NHÁNH 1: PER_TXN chặn đúng 600k, số dư và usage nguyên vẹn');

    // --------------------------------------------------------------------------
    // NHÁNH 2: Biến thể 3 x 200.000đ (Vượt hạn mức ngày: 500.000đ)
    // --------------------------------------------------------------------------
    logger.section('NHÁNH 2: Biến thể 3 x 200.000đ (Lần 1, 2 thành công; Lần 3 bị PER_DAY)');

    // Giao dịch 1: 200.000đ
    logger.info('Thực hiện giao dịch 1: Chuyển 200.000đ');
    const key1 = `a9-step-1-${randomUUID()}`;
    const chk1 = await apiCall('/payments/p2p/checkout', {
      method: 'POST',
      token: accounts.chi.token,
      headers: { 'Idempotency-Key': key1 },
      body: { destinationUserId: accounts.binh.userId, amount: '200000' },
      expected: 201
    });
    const token1 = await getPinTransactionToken(accounts.chi.token, chk1.data.data.id, '200000');
    const conf1 = await apiCall(`/payments/${chk1.data.data.id}/confirm`, {
      method: 'POST',
      token: accounts.chi.token,
      body: { transactionToken: token1 },
      expected: 200
    });
    assert.equal(conf1.data.data.status, 'SUCCESS');
    logger.info('Giao dịch 1 hoàn tất thành công (200.000đ)');

    // Giao dịch 2: 200.000đ
    logger.info('Thực hiện giao dịch 2: Chuyển 200.000đ');
    const key2 = `a9-step-2-${randomUUID()}`;
    const chk2 = await apiCall('/payments/p2p/checkout', {
      method: 'POST',
      token: accounts.chi.token,
      headers: { 'Idempotency-Key': key2 },
      body: { destinationUserId: accounts.binh.userId, amount: '200000' },
      expected: 201
    });
    const token2 = await getPinTransactionToken(accounts.chi.token, chk2.data.data.id, '200000');
    const conf2 = await apiCall(`/payments/${chk2.data.data.id}/confirm`, {
      method: 'POST',
      token: accounts.chi.token,
      body: { transactionToken: token2 },
      expected: 200
    });
    assert.equal(conf2.data.data.status, 'SUCCESS');
    logger.info('Giao dịch 2 hoàn tất thành công (200.000đ)');

    // Kiểm tra usage sau 2 lần: đã dùng 400.000đ
    const usageAfterTwo = await prisma.userDailyUsage.findFirstOrThrow({ where: { userId: accounts.chi.userId } });
    assert.equal(Number(usageAfterTwo.spentDay), 400000, 'Usage spentDay sau 2 lần phải là 400.000đ');
    logger.info(`Usage hiện tại của Chi trong ngày: ${Number(usageAfterTwo.spentDay).toLocaleString()} / 500.000 VND (còn lại 100.000 VND)`);

    // Giao dịch 3: Chuyển tiếp 200.000đ (Tổng ngày sẽ là 600.000 > 500.000)
    logger.info('Thực hiện giao dịch 3: Chuyển tiếp 200.000đ (kỳ vọng bị chặn PER_DAY)');
    const key3 = `a9-step-3-${randomUUID()}`;
    const resOverDay = await apiCall('/payments/p2p/checkout', {
      method: 'POST',
      token: accounts.chi.token,
      headers: { 'Idempotency-Key': key3 },
      body: { destinationUserId: accounts.binh.userId, amount: '200000' }
    });

    logger.info(`Kết quả lần 3: status=${resOverDay.status}, code=${resOverDay.data?.error?.code}, limitType=${resOverDay.data?.error?.details?.limitType}, remaining=${resOverDay.data?.error?.details?.remaining}`);
    assert.equal(resOverDay.status, 422, 'Lần 3 phải trả về HTTP 422');
    assert.equal(resOverDay.data?.error?.code, 'LIMIT_EXCEEDED');
    assert.equal(resOverDay.data?.error?.details?.limitType, 'PER_DAY', 'limitType phải là PER_DAY');
    assert.equal(resOverDay.data?.error?.details?.remaining, '100000.00', 'remaining phải đúng 100.000đ');

    // Kiểm tra số dư và usage KHÔNG bị tăng thêm sau lần 3
    const chiWalletFinal = await prisma.wallet.findUniqueOrThrow({ where: { id: accounts.chi.walletId } });
    const usageAfterReject = await prisma.userDailyUsage.findFirstOrThrow({ where: { userId: accounts.chi.userId } });

    assert.equal(Number(chiWalletFinal.balance), 700000, 'Số dư ví Chi dừng lại ở 700.000đ (1.100k - 200k - 200k)');
    assert.equal(Number(chiWalletFinal.heldBalance), 0, 'Held balance ví Chi = 0');
    assert.equal(Number(usageAfterReject.spentDay), 400000, 'Usage spentDay giữ nguyên 400.000đ');

    branchPerDayPassed = true;
    logger.result(true, 'ĐẠT NHÁNH 2: PER_DAY chặn lần 3 chính xác, remaining = 100.000đ');

  } finally {
    logger.section('KIỂM TRA BẢO TOÀN TIỀN VÀ HẬU KIỂM');
    const snapshotAfter = await getFinancialSnapshot(prisma);
    const conservationAfter = await checkSystemConservation(prisma);
    const delta = verifyDeltaConservation(snapshotBefore, snapshotAfter);

    logger.info(`Snapshot tài chính SAU: TotalBalance=${snapshotAfter.totalBalance}, TotalDebit=${snapshotAfter.totalDebit}, TotalCredit=${snapshotAfter.totalCredit}`);
    logger.info(`Bảo toàn: isConserved=${delta.isBalanceConserved}, deltaBalance=${delta.deltaBalance}, deltaCreditDebit=${delta.deltaCreditDebit}`);

    assert.equal(conservationAfter.passed, true, `Bảo toàn hệ thống sau kịch bản A9 phải đạt: ${conservationAfter.errors.join('; ')}`);
    assert.equal(delta.passed, true, 'Biến thiên số dư và sổ cái phải bảo toàn');
  }

  const overallPassed = branchPerTxnPassed && branchPerDayPassed;
  logger.section(`KẾT LUẬN NGHIỆM THU A9: ${overallPassed ? 'PASS' : 'FAIL'}`);
  logger.info(`Đường dẫn file log: ${logger.filePath}`);

  return {
    passed: overallPassed,
    logFile: logger.filePath
  };
}

if (import.meta.main || (process.argv[1] && process.argv[1].endsWith('a9-scenario.mjs'))) {
  runA9()
    .then(res => process.exit(res.passed ? 0 : 1))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
