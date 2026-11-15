/**
 * KỊCH BẢN NGHIỆM THU A2: BẤM HAI LẦN (IDEMPOTENT CHECKOUT)
 * Định nghĩa ĐÚNG:
 * - Gửi checkout 2 lần liên tiếp cùng Idempotency-Key: chỉ có 1 payment, lần 2 trả replayed: true.
 * - Biến thể 2 lần song song: đúng 1 payment được tạo trong DB, 1 hold trong DB, lần 2 trả replayed: true (sau khi lock giải phóng), cùng paymentId.
 * - Kiểm tra bảo toàn tiền trước và sau.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createK20Logger,
  resetToSeed,
  loginSeed,
  apiCall,
  getFinancialSnapshot,
  checkSystemConservation,
  verifyDeltaConservation,
  getWalletPrisma
} from './k20-shared.mjs';

export async function runA2() {
  const logger = createK20Logger('A2');
  logger.section('BẮT ĐẦU KỊCH BẢN NGHIỆM THU A2: BẤM HAI LẦN');

  const prisma = getWalletPrisma();

  // 1. Reset về seed sạch
  logger.info('Bước 1: Reset môi trường về trạng thái seed sạch');
  const { accounts, conservation: initialConservation } = await resetToSeed({ forScenario: 'DEFAULT' });
  assert.equal(initialConservation.passed, true, 'Bảo toàn seed ban đầu phải đạt');
  logger.info(`Seed sẵn sàng: An=${accounts.an.email}, Binh=${accounts.binh.email}`);

  const snapshotBefore = await getFinancialSnapshot(prisma);
  logger.info(`Snapshot tài chính TRƯỚC: TotalBalance=${snapshotBefore.totalBalance}, TotalDebit=${snapshotBefore.totalDebit}, TotalCredit=${snapshotBefore.totalCredit}`);

  let testSeqPassed = false;
  let testParPassed = false;

  try {
    // --------------------------------------------------------------------------
    // NHÁNH 1: Hai lần liên tiếp (Sequential Replay)
    // --------------------------------------------------------------------------
    logger.section('NHÁNH 1: Gửi 2 lần checkout liên tiếp cùng Idempotency-Key');
    const seqKey = `a2-seq-${randomUUID()}`;
    const amount = '50000';

    logger.info(`Request 1: POST /api/payments/p2p/checkout (Idempotency-Key: ${seqKey}, amount: 50.000đ)`);
    const res1 = await apiCall('/payments/p2p/checkout', {
      method: 'POST',
      token: accounts.an.token,
      headers: { 'Idempotency-Key': seqKey },
      body: {
        destinationUserId: accounts.binh.userId,
        amount
      },
      expected: 201
    });

    logger.info(`Response 1 status=${res1.status}, paymentId=${res1.data.data.id}, replayed=${res1.data.data.replayed}`);
    assert.equal(res1.status, 201, 'Request 1 phải trả HTTP 201');
    assert.equal(res1.data.data.replayed, false, 'Request 1 phải có replayed = false');
    const paymentId1 = res1.data.data.id;
    const holdId1 = res1.data.data.holdId;
    assert.ok(paymentId1, 'Request 1 phải có paymentId');
    assert.ok(holdId1, 'Request 1 phải có holdId');

    // Gửi lần 2 tuần tự ngay sau đó
    logger.info(`Request 2: POST /api/payments/p2p/checkout (cùng Idempotency-Key: ${seqKey})`);
    const res2 = await apiCall('/payments/p2p/checkout', {
      method: 'POST',
      token: accounts.an.token,
      headers: { 'Idempotency-Key': seqKey },
      body: {
        destinationUserId: accounts.binh.userId,
        amount
      }
    });

    logger.info(`Response 2 status=${res2.status}, paymentId=${res2.data?.data?.id}, replayed=${res2.data?.data?.replayed}`);
    assert.ok([200, 201].includes(res2.status), `Request 2 phải trả HTTP 200 hoặc 201, nhận ${res2.status}`);
    assert.equal(res2.data.data.replayed, true, 'Request 2 ĐÚNG: phải có replayed = true');
    assert.equal(res2.data.data.id, paymentId1, 'Request 2 ĐÚNG: phải trả về cùng paymentId với lần 1');

    // Kiểm tra DB: Chỉ có đúng 1 payment và đúng 1 hold
    const { execFileSync } = await import('node:child_process');
    const paymentCountSeq = execFileSync('docker', [
      'exec', '-i', 'ptpmhdv_backend-postgres-1',
      'psql', '-U', 'postgres', '-d', 'payment_service',
      '-At', '-c', `SELECT count(*) FROM "Payment" WHERE "idempotencyKey"='${seqKey}';`
    ], { encoding: 'utf8' }).trim();

    const holdCountSeq = await prisma.walletHold.count({
      where: { referenceId: holdId1 }
    });

    logger.info(`Kiểm tra DB Nhánh 1: Payment count với idempotencyKey=${paymentCountSeq} (kỳ vọng 1), Hold count=${holdCountSeq} (kỳ vọng 1)`);
    assert.equal(paymentCountSeq, '1', 'Trong DB Payment chỉ có đúng 1 record');
    assert.equal(holdCountSeq, 1, 'Trong DB WalletHold chỉ có đúng 1 record');

    testSeqPassed = true;
    logger.result(true, 'ĐẠT NHÁNH 1: Sequential Replay chuẩn xác (1 payment, lần 2 replayed: true, 1 hold)');

    // --------------------------------------------------------------------------
    // NHÁNH 2: Biến thể 2 lần song song (Concurrent Checkout)
    // --------------------------------------------------------------------------
    logger.section('NHÁNH 2: Gửi 2 lần checkout song song cùng Idempotency-Key');
    const parKey = `a2-par-${randomUUID()}`;

    logger.info(`Bắn đồng thời 2 request POST /api/payments/p2p/checkout với cùng Idempotency-Key: ${parKey}`);
    const [parResA, parResB] = await Promise.all([
      apiCall('/payments/p2p/checkout', {
        method: 'POST',
        token: accounts.an.token,
        headers: { 'Idempotency-Key': parKey },
        body: { destinationUserId: accounts.binh.userId, amount }
      }),
      apiCall('/payments/p2p/checkout', {
        method: 'POST',
        token: accounts.an.token,
        headers: { 'Idempotency-Key': parKey },
        body: { destinationUserId: accounts.binh.userId, amount }
      })
    ]);

    logger.info(`Response A: status=${parResA.status}, replayed=${parResA.data?.data?.replayed}, id=${parResA.data?.data?.id}, code=${parResA.data?.error?.code}`);
    logger.info(`Response B: status=${parResB.status}, replayed=${parResB.data?.data?.replayed}, id=${parResB.data?.data?.id}, code=${parResB.data?.error?.code}`);

    const parResponses = [parResA, parResB];
    const completedReq = parResponses.find(r => r.status === 201 && r.data?.data?.replayed === false);
    assert.ok(completedReq, 'Phải có đúng 1 request ban đầu được chấp nhận (HTTP 201, replayed: false)');
    const winnerPaymentId = completedReq.data.data.id;
    const winnerHoldId = completedReq.data.data.holdId;

    // Request còn lại: nếu chạy song song hoàn toàn cùng millisecond, request thứ hai hoặc:
    // a) Đến ngay khi request 1 đang giữ lock -> nhận 503 / 409 WALLET_UNAVAILABLE / IDEMPOTENCY_REQUEST_IN_PROGRESS (Safe in-flight guard)
    // b) Hoặc đến ngay khi request 1 vừa hoàn tất -> nhận 201 replayed: true.
    // Nếu nhận in-flight guard (503/409), gửi replay request ngay lập tức theo cơ chế Safe Retry K18:
    let replayedData = parResponses.find(r => r.data?.data?.replayed === true)?.data?.data;
    if (!replayedData) {
      logger.info('Request song song thứ hai bị chặn an toàn do đang xử lý (in-flight guard). Thực hiện replay theo chuẩn Safe Retry K18...');
      await delay(100);
      const retryRes = await apiCall('/payments/p2p/checkout', {
        method: 'POST',
        token: accounts.an.token,
        headers: { 'Idempotency-Key': parKey },
        body: { destinationUserId: accounts.binh.userId, amount }
      });
      logger.info(`Retry Response: status=${retryRes.status}, paymentId=${retryRes.data?.data?.id}, replayed=${retryRes.data?.data?.replayed}`);
      assert.ok([200, 201].includes(retryRes.status));
      assert.equal(retryRes.data.data.replayed, true, 'Lần gọi lại ĐÚNG: phải có replayed = true');
      replayedData = retryRes.data.data;
    }

    assert.equal(replayedData.id, winnerPaymentId, 'Cả hai request phải gắn với cùng 1 paymentId');

    const paymentCountPar = execFileSync('docker', [
      'exec', '-i', 'ptpmhdv_backend-postgres-1',
      'psql', '-U', 'postgres', '-d', 'payment_service',
      '-At', '-c', `SELECT count(*) FROM "Payment" WHERE "idempotencyKey"='${parKey}';`
    ], { encoding: 'utf8' }).trim();

    const holdCountPar = await prisma.walletHold.count({
      where: { referenceId: winnerHoldId }
    });

    logger.info(`Kiểm tra DB Nhánh 2: Payment count=${paymentCountPar} (kỳ vọng 1), Hold count=${holdCountPar} (kỳ vọng 1)`);
    assert.equal(paymentCountPar, '1', 'Trong DB Payment chỉ có đúng 1 record cho concurrent checkout');
    assert.equal(holdCountPar, 1, 'Trong DB WalletHold chỉ có đúng 1 record');

    testParPassed = true;
    logger.result(true, 'ĐẠT NHÁNH 2: Concurrent Replay chuẩn xác (đúng 1 payment, 1 hold, replayed: true)');

  } finally {
    // Dọn dẹp hold và kiểm tra bảo toàn
    logger.section('KIỂM TRA BẢO TOÀN TIỀN VÀ HẬU KIỂM');
    await prisma.walletHold.updateMany({
      where: { sourceWalletId: accounts.an.walletId, status: 'PENDING' },
      data: { status: 'RELEASED' }
    });
    await prisma.wallet.update({
      where: { id: accounts.an.walletId },
      data: { heldBalance: 0 }
    });

    const snapshotAfter = await getFinancialSnapshot(prisma);
    const conservationAfter = await checkSystemConservation(prisma);
    const delta = verifyDeltaConservation(snapshotBefore, snapshotAfter);

    logger.info(`Snapshot tài chính SAU: TotalBalance=${snapshotAfter.totalBalance}, TotalDebit=${snapshotAfter.totalDebit}, TotalCredit=${snapshotAfter.totalCredit}`);
    logger.info(`Bảo toàn: isConserved=${delta.isBalanceConserved}, deltaBalance=${delta.deltaBalance}, deltaCreditDebit=${delta.deltaCreditDebit}`);

    assert.equal(conservationAfter.passed, true, `Bảo toàn hệ thống sau kịch bản A2 phải đạt: ${conservationAfter.errors.join('; ')}`);
    assert.equal(delta.passed, true, 'Biến thiên số dư và sổ cái phải bảo toàn');
  }

  const overallPassed = testSeqPassed && testParPassed;
  logger.section(`KẾT LUẬN NGHIỆM THU A2: ${overallPassed ? 'PASS' : 'FAIL'}`);
  logger.info(`Đường dẫn file log: ${logger.filePath}`);

  return {
    passed: overallPassed,
    logFile: logger.filePath
  };
}

if (import.meta.main || (process.argv[1] && process.argv[1].endsWith('a2-scenario.mjs'))) {
  runA2()
    .then(res => process.exit(res.passed ? 0 : 1))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
