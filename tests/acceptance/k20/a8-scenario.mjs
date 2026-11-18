/**
 * Scenario A8: Đối soát và điều chỉnh W4 (Reconciliation & Anomaly Adjustment)
 * K20 / K21 Acceptance Verification (Mục G8)
 *
 * Specification:
 * 1. Baseline: Chạy đối soát trên seed sạch (GET /api/wallets/admin/reconciliation?mode=full)
 *    -> isBalanced = true, không có anomaly trên seed wallets.
 * 2. Intentional Drift: Cố ý sửa số dư ví Binh thêm +50.000đ bằng SQL trực tiếp (không qua Ledger).
 * 3. Quét đối soát: Phát hiện isBalanced = false, 1 anomaly BALANCE_DRIFT trên ví Binh
 *    (expected = 300,000, actual = 350,000, difference = 50,000).
 * 4. Kiểm tra validate W4:
 *    - Thiếu reason / reason < 5 ký tự -> HTTP 400 REASON_REQUIRED.
 *    - Sai direction (CREDIT thay vì DEBIT) -> HTTP 400 DIRECTION_MISMATCH.
 *    - Sai amount (20.000 thay vì 50.000) -> HTTP 400 AMOUNT_MISMATCH.
 *    - Gọi hợp lệ với reason >= 10 ký tự -> HTTP 200, status = RESOLVED, replayed = false.
 *    - Gọi lặp lại cùng referenceId -> HTTP 200, status = RESOLVED, replayed = true (Idempotent).
 * 5. Hậu kiểm:
 *    - Số dư ví Binh trở về đúng 300,000 VND.
 *    - Đối soát lại: isBalanced = true, 0 bất thường trên ví Binh.
 *    - Bất biến LedgerEntry: Số lượng và checksum không đổi so với trước W4 (W4 không can thiệp sổ cái).
 *    - Bảo toàn hệ thống: sum(Wallet.balance) = 0.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createK20Logger,
  resetToSeed,
  apiCall,
  executeSql,
  getFinancialSnapshot,
  checkSystemConservation,
  getWalletPrisma
} from './k20-shared.mjs';

export async function runA8() {
  const logger = createK20Logger('A8');
  logger.section('BẮT ĐẦU KỊCH BẢN NGHIỆM THU A8: ĐỐI SOÁT VÀ ĐIỀU CHỈNH W4');

  const prisma = getWalletPrisma();
  const checks = [];

  // Helper ghi nhận check
  const recordCheck = (name, pass, details = '') => {
    checks.push({ name, pass, details });
    if (pass) {
      logger.info(`  [PASS] ${name}${details ? ` (${details})` : ''}`);
    } else {
      logger.error(`  [FAIL] ${name}${details ? ` (${details})` : ''}`);
    }
  };

  try {
    // --------------------------------------------------------------------------
    // BƯỚC 1: Baseline trên seed sạch
    // --------------------------------------------------------------------------
    logger.section('BƯỚC 1: Baseline đối soát trên môi trường seed sạch');
    const { accounts, conservation: initialConservation } = await resetToSeed({ forScenario: 'DEFAULT' });
    recordCheck('Môi trường seed ban đầu bảo toàn = 0', initialConservation.passed);

    const admin = accounts.admin;
    const binh = accounts.binh;
    logger.info(`Tài khoản thử nghiệm: Admin=${admin.email}, Binh=${binh.email} (WalletId: ${binh.walletId})`);

    // Lưu snapshot sổ cái trước khi can thiệp
    const snapshotBefore = await getFinancialSnapshot(prisma);
    logger.info(`Snapshot trước drift: LedgerCount=${snapshotBefore.debitCount + snapshotBefore.creditCount}, Checksum=${snapshotBefore.ledgerChecksum}`);

    // Chạy đối soát Baseline
    logger.info('Gọi GET /api/wallets/admin/reconciliation?mode=full');
    const baseScanRes = await apiCall('/wallets/admin/reconciliation?mode=full', {
      method: 'GET',
      token: admin.token,
      expected: 200
    });

    const baseScanData = baseScanRes.data?.data || baseScanRes.data;
    const isBaseBalanced = baseScanData?.isBalanced === true;
    const baseAnomalies = baseScanData?.anomalies || [];
    const binhBaseAnomalies = baseAnomalies.filter(a => a.walletId === binh.walletId);

    recordCheck('Baseline đối soát isBalanced = true', isBaseBalanced, `isBalanced: ${baseScanData?.isBalanced}`);
    recordCheck('Baseline không có anomaly trên ví Binh', binhBaseAnomalies.length === 0, `Số lượng: ${binhBaseAnomalies.length}`);

    // --------------------------------------------------------------------------
    // BƯỚC 2: Cố ý làm lệch số dư (Intentional Drift +50.000đ)
    // --------------------------------------------------------------------------
    logger.section('BƯỚC 2: Cố ý làm lệch số dư ví Binh (+50.000đ) qua SQL trực tiếp');
    const DRIFT_AMOUNT = 50000;
    await executeSql('wallet_service', `UPDATE "Wallet" SET balance = balance + ${DRIFT_AMOUNT}.00 WHERE id = ${binh.walletId};`);

    const binhDriftWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: binh.walletId } });
    logger.info(`Số dư ví Binh sau drift: ${binhDriftWallet.balance} VND (Kỳ vọng: 350.000 VND)`);
    recordCheck('Ví Binh đã bị drift lên 350.000 VND', Number(binhDriftWallet.balance) === 350000, `Actual: ${binhDriftWallet.balance}`);

    // Kiểm tra conservation nội bộ phát hiện không đạt
    const driftConservation = await checkSystemConservation(prisma);
    recordCheck('checkSystemConservation phát hiện lệch hệ thống', !driftConservation.passed, `Total balance: ${driftConservation.snapshot.totalBalance}`);

    // --------------------------------------------------------------------------
    // BƯỚC 3: Quét đối soát phát hiện drift
    // --------------------------------------------------------------------------
    logger.section('BƯỚC 3: Quét đối soát chế độ full để phát hiện drift');
    const driftScanRes = await apiCall('/wallets/admin/reconciliation?mode=full', {
      method: 'GET',
      token: admin.token,
      expected: 200
    });

    const driftScanData = driftScanRes.data?.data || driftScanRes.data;
    const isDriftBalanced = driftScanData?.isBalanced;
    recordCheck('Đối soát phát hiện hệ thống không cân bằng (isBalanced = false)', isDriftBalanced === false, `isBalanced: ${isDriftBalanced}`);

    const anomaliesList = driftScanData?.anomalies || [];
    const driftAnomaly = anomaliesList.find(a => a.walletId === binh.walletId && a.type === 'BALANCE_DRIFT');
    recordCheck('Tìm thấy anomaly BALANCE_DRIFT trên ví Binh', !!driftAnomaly, driftAnomaly ? `Id: ${driftAnomaly.id}` : 'Không tìm thấy');

    if (!driftAnomaly) {
      throw new Error('Không tìm thấy anomaly BALANCE_DRIFT trên ví Binh sau khi inject drift!');
    }

    const anomalyId = driftAnomaly.id;
    const diffNum = Number(driftAnomaly.difference);
    const expectedNum = Number(driftAnomaly.expected);
    const actualNum = Number(driftAnomaly.actual);

    logger.info(`Chi tiết Anomaly: Id=${anomalyId}, Type=${driftAnomaly.type}, Expected=${driftAnomaly.expected}, Actual=${driftAnomaly.actual}, Difference=${driftAnomaly.difference}`);
    recordCheck('Expected balance = 300.000đ', expectedNum === 300000, `Actual expected: ${driftAnomaly.expected}`);
    recordCheck('Actual balance = 350.000đ', actualNum === 350000, `Actual: ${driftAnomaly.actual}`);
    recordCheck('Difference = 50.000đ', diffNum === 50000, `Difference: ${driftAnomaly.difference}`);

    // --------------------------------------------------------------------------
    // BƯỚC 4: Kiểm thử điều chỉnh W4 và validations
    // --------------------------------------------------------------------------
    logger.section('BƯỚC 4: Kiểm thử API điều chỉnh W4 và validation invariants');

    // 4.1. Thiếu reason
    logger.info('4.1: Gửi request điều chỉnh không có reason');
    try {
      const noReasonRes = await apiCall(`/wallets/admin/reconciliation/anomalies/${anomalyId}/adjust`, {
        method: 'POST',
        token: admin.token,
        body: { direction: 'DEBIT', amount: '50000' }
      });
      recordCheck('Từ chối khi thiếu reason (HTTP 400)', noReasonRes.status === 400, `Status: ${noReasonRes.status}`);
    } catch (e) {
      const code = e.data?.error?.code || e.data?.code;
      recordCheck('Từ chối khi thiếu reason với mã REASON_REQUIRED', e.status === 400 && code === 'REASON_REQUIRED', `Status: ${e.status}, Code: ${code}`);
    }

    // 4.2. Reason quá ngắn (< 5 ký tự)
    logger.info('4.2: Gửi request điều chỉnh với reason < 5 ký tự ("abc")');
    try {
      const shortReasonRes = await apiCall(`/wallets/admin/reconciliation/anomalies/${anomalyId}/adjust`, {
        method: 'POST',
        token: admin.token,
        body: { reason: 'abc', direction: 'DEBIT', amount: '50000' }
      });
      recordCheck('Từ chối khi reason < 5 ký tự (HTTP 400)', shortReasonRes.status === 400, `Status: ${shortReasonRes.status}`);
    } catch (e) {
      const code = e.data?.error?.code || e.data?.code;
      recordCheck('Từ chối khi reason ngắn với mã REASON_REQUIRED', e.status === 400 && code === 'REASON_REQUIRED', `Status: ${e.status}, Code: ${code}`);
    }

    // 4.3. Direction mismatch (cần DEBIT nhưng gửi CREDIT)
    logger.info('4.3: Gửi sai direction: CREDIT thay vì DEBIT');
    try {
      const dirMismatchRes = await apiCall(`/wallets/admin/reconciliation/anomalies/${anomalyId}/adjust`, {
        method: 'POST',
        token: admin.token,
        body: { direction: 'CREDIT', amount: '50000', reason: 'Sai huong dieu chinh' }
      });
      recordCheck('Từ chối khi sai direction (HTTP 400)', dirMismatchRes.status === 400, `Status: ${dirMismatchRes.status}`);
    } catch (e) {
      const code = e.data?.error?.code || e.data?.code;
      recordCheck('Từ chối sai direction với mã DIRECTION_MISMATCH', e.status === 400 && code === 'DIRECTION_MISMATCH', `Status: ${e.status}, Code: ${code}`);
    }

    // 4.4. Amount mismatch (cần 50.000 nhưng gửi 20.000)
    logger.info('4.4: Gửi sai amount: 20000 thay vì 50000');
    try {
      const amtMismatchRes = await apiCall(`/wallets/admin/reconciliation/anomalies/${anomalyId}/adjust`, {
        method: 'POST',
        token: admin.token,
        body: { direction: 'DEBIT', amount: '20000', reason: 'Sai so tien can dieu chinh' }
      });
      recordCheck('Từ chối khi sai amount (HTTP 400)', amtMismatchRes.status === 400, `Status: ${amtMismatchRes.status}`);
    } catch (e) {
      const code = e.data?.error?.code || e.data?.code;
      recordCheck('Từ chối sai amount với mã AMOUNT_MISMATCH', e.status === 400 && code === 'AMOUNT_MISMATCH', `Status: ${e.status}, Code: ${code}`);
    }

    // 4.5. Điều chỉnh hợp lệ lần đầu (replayed = false)
    const validRefId = `k20-a8-adj-${randomUUID()}`;
    const validReason = 'Dieu chinh lech so du theo bien ban kiem toan k20';
    logger.info(`4.5: Gửi điều chỉnh hợp lệ: direction=DEBIT, amount=50000, referenceId=${validRefId}`);

    const adjustRes = await apiCall(`/wallets/admin/reconciliation/anomalies/${anomalyId}/adjust`, {
      method: 'POST',
      token: admin.token,
      body: {
        direction: 'DEBIT',
        amount: '50000',
        referenceId: validRefId,
        reason: validReason
      },
      expected: 200
    });

    const adjustData = adjustRes.data?.data || adjustRes.data;
    logger.info(`Kết quả adjust: status=${adjustData?.status}, replayed=${adjustData?.replayed}, delta=${adjustData?.delta}`);
    recordCheck('Điều chỉnh thành công status = RESOLVED', adjustData?.status === 'RESOLVED', `Status: ${adjustData?.status}`);
    recordCheck('Lần gọi đầu có replayed = false', adjustData?.replayed === false, `Replayed: ${adjustData?.replayed}`);
    recordCheck('ReferenceId được ghi nhận đúng', adjustData?.referenceId === validRefId, `RefId: ${adjustData?.referenceId}`);

    // 4.6. Idempotent Replay (Gọi lại cùng referenceId và payload)
    logger.info('4.6: Gọi lại điều chỉnh với cùng referenceId để xác minh Idempotency');
    const replayRes = await apiCall(`/wallets/admin/reconciliation/anomalies/${anomalyId}/adjust`, {
      method: 'POST',
      token: admin.token,
      body: {
        direction: 'DEBIT',
        amount: '50000',
        referenceId: validRefId,
        reason: validReason
      },
      expected: 200
    });

    const replayData = replayRes.data?.data || replayRes.data;
    logger.info(`Kết quả replay: status=${replayData?.status}, replayed=${replayData?.replayed}`);
    recordCheck('Replay thành công status = RESOLVED', replayData?.status === 'RESOLVED', `Status: ${replayData?.status}`);
    recordCheck('Replay trả về replayed = true', replayData?.replayed === true, `Replayed: ${replayData?.replayed}`);

    // --------------------------------------------------------------------------
    // BƯỚC 5: Hậu kiểm tính bảo toàn và bất biến sổ cái
    // --------------------------------------------------------------------------
    logger.section('BƯỚC 5: Hậu kiểm số dư, đối soát lại và bất biến sổ cái');

    // 5.1. Số dư ví Binh đã trở về 300.000đ
    const binhEndWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: binh.walletId } });
    logger.info(`Số dư ví Binh sau điều chỉnh: ${binhEndWallet.balance} VND (Kỳ vọng: 300.000 VND)`);
    recordCheck('Số dư ví Binh trở về đúng 300.000 VND', Number(binhEndWallet.balance) === 300000, `Actual: ${binhEndWallet.balance}`);

    // 5.2. Quét đối soát lại
    logger.info('Gọi lại GET /api/wallets/admin/reconciliation?mode=full sau điều chỉnh');
    const postScanRes = await apiCall('/wallets/admin/reconciliation?mode=full', {
      method: 'GET',
      token: admin.token,
      expected: 200
    });
    const postScanData = postScanRes.data?.data || postScanRes.data;
    const postAnomalies = postScanData?.anomalies || [];
    const binhPostAnomalies = postAnomalies.filter(a => a.walletId === binh.walletId);

    recordCheck('Đối soát sau điều chỉnh isBalanced = true', postScanData?.isBalanced === true, `isBalanced: ${postScanData?.isBalanced}`);
    recordCheck('Không còn anomaly mở trên ví Binh', binhPostAnomalies.length === 0, `Anomalies count: ${binhPostAnomalies.length}`);

    // 5.3. Bất biến LedgerEntry: Số lượng và Checksum KHÔNG ĐỔI
    const snapshotAfter = await getFinancialSnapshot(prisma);
    const ledgerCountBefore = snapshotBefore.debitCount + snapshotBefore.creditCount;
    const ledgerCountAfter = snapshotAfter.debitCount + snapshotAfter.creditCount;

    logger.info(`Kiểm tra LedgerEntry: Before Count=${ledgerCountBefore}, After Count=${ledgerCountAfter}`);
    logger.info(`Checksum: Before=${snapshotBefore.ledgerChecksum}, After=${snapshotAfter.ledgerChecksum}`);
    recordCheck('Số lượng LedgerEntry không đổi (W4 không sửa sổ cái)', ledgerCountAfter === ledgerCountBefore, `Before: ${ledgerCountBefore}, After: ${ledgerCountAfter}`);
    recordCheck('Checksum LedgerEntry hoàn toàn đồng nhất', snapshotAfter.ledgerChecksum === snapshotBefore.ledgerChecksum, `Checksum match: ${snapshotAfter.ledgerChecksum === snapshotBefore.ledgerChecksum}`);

    // 5.4. Bảo toàn tổng số dư hệ thống
    const finalConservation = await checkSystemConservation(prisma);
    recordCheck('Hệ thống đạt toàn bộ tiêu chí bảo toàn tiền', finalConservation.passed, finalConservation.errors.join('; ') || 'OK');
    recordCheck('Tổng số dư toàn hệ thống = 0', Math.abs(finalConservation.snapshot.totalBalance) < 0.01, `Total balance: ${finalConservation.snapshot.totalBalance}`);

  } catch (err) {
    logger.error(`A8 gặp lỗi ngoại lệ: ${err.message}\n${err.stack}`);
    recordCheck('Thực thi A8 không ném lỗi ngoại lệ', false, err.message);
  }

  const allPassed = checks.every(c => c.pass);
  logger.section('TỔNG KẾT KỊCH BẢN A8');
  logger.result(
    allPassed,
    allPassed
      ? 'KỊCH BẢN A8 PASS TOÀN BỘ (Baseline sạch, phát hiện drift +50k, validate W4 chuẩn, điều chỉnh và hậu kiểm bảo toàn 100%)'
      : `KỊCH BẢN A8 FAIL (${checks.filter(c => !c.pass).length} kiểm tra không đạt)`
  );

  return {
    passed: allPassed,
    checks,
    logFile: logger.filePath
  };
}

if (process.argv[1] && process.argv[1].endsWith('a8-scenario.mjs')) {
  runA8()
    .then(res => process.exit(res.passed ? 0 : 1))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
