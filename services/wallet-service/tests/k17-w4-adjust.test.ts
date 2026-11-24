import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient, OwnerType, AnomalyType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { createTestGatewayToken } from 'finvault-internal-auth';

const prisma = new PrismaClient();

const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';

const adminToken = () => createTestGatewayToken(ADMIN_ID, 'ADMIN');
const userToken = () => createTestGatewayToken(USER_ID, 'USER');

test('W4 detects and repairs a cache drift on a wallet with no ledger rows', async () => {
  const { ReconciliationService } = await import('../src/services/reconciliation.service');
  const service = new ReconciliationService();
  const wallet = await prisma.wallet.create({ data: { userId: randomUUID(), ownerType: OwnerType.USER,
    balance: '5000', heldBalance: '0' } });
  const reports: number[] = [];
  try {
    for (const mode of ['quick', 'full'] as const) {
      const report = await service.runReconciliation(mode);
      reports.push(report.id);
      const anomaly = report.anomalies.find(item => item.walletId === wallet.id && item.type === 'BALANCE_DRIFT');
      assert.ok(anomaly, mode + ' must include a newly created wallet whose cache is nonzero');
      assert.equal(anomaly.expected, '0.00');
      assert.equal(anomaly.difference, '5000.00');
      if (mode === 'full') {
        const result = await service.adjustAnomaly(anomaly.id,
          { direction: 'DEBIT', amount: '5000', reason: 'Restore empty wallet cache' }, ADMIN_ID);
        assert.equal(result.transactionId, null);
        assert.equal((await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).balance.toFixed(2), '0.00');
        assert.equal(await prisma.ledgerEntry.count({ where: { walletId: wallet.id } }), 0);
      }
    }
  } finally {
    await prisma.anomalyAdjustment.deleteMany({ where: { walletId: wallet.id } });
    await prisma.reconciliationReport.deleteMany({ where: { id: { in: reports } } });
    await prisma.wallet.delete({ where: { id: wallet.id } });
  }
});

test('W4 cache repair preserves holds and rolls back unsafe repairs', async () => {
  const { ReconciliationService } = await import('../src/services/reconciliation.service');
  const service = new ReconciliationService();
  const wallet = await prisma.wallet.create({ data: { userId: randomUUID(), ownerType: OwnerType.USER,
    balance: '205000', heldBalance: '201000' } });
  const report = await prisma.reconciliationReport.create({ data: { totalWallets: 1, anomaliesFound: 1,
    systemBalanceExpected: '0', systemBalanceActual: '5000', isBalanced: false } });
  const anomaly = await prisma.reconciliationAnomaly.create({ data: { reportId: report.id,
    type: 'BALANCE_DRIFT_FULL', walletId: wallet.id, expected: '200000', actual: '205000',
    difference: '5000', detail: {} } });
  await prisma.ledgerEntry.create({ data: { transactionId: randomUUID(), walletId: wallet.id,
    direction: 'CREDIT', amount: '200000', balanceAfter: '200000', referenceId: randomUUID(), transferType: 'TOPUP' } });
  const before = await prisma.ledgerEntry.findMany({ where: { walletId: wallet.id } });
  const input = { direction: 'DEBIT', amount: '5000', reason: 'Repair cache after reconciliation',
    referenceId: `adjust-anomaly-${anomaly.id}` };
  try {
    await assert.rejects(service.adjustAnomaly(String(anomaly.id), input, ADMIN_ID),
      (error: any) => error.code === 'REPAIR_CONFLICTS_WITH_HOLDS');
    assert.equal((await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).balance.toFixed(2), '205000.00');
    assert.equal((await prisma.reconciliationAnomaly.findUniqueOrThrow({ where: { id: anomaly.id } })).status, 'OPEN');
    assert.equal(await prisma.anomalyAdjustment.count({ where: { anomalyId: anomaly.id } }), 0);
    await prisma.wallet.update({ where: { id: wallet.id }, data: { heldBalance: '150000' } });
    await assert.rejects(service.adjustAnomaly(String(anomaly.id), { ...input, referenceId: 'arbitrary-reference' }, ADMIN_ID),
      (error: any) => error.code === 'INVALID_REFERENCE_ID');
    const results = await Promise.all([service.adjustAnomaly(String(anomaly.id), input, ADMIN_ID),
      service.adjustAnomaly(String(anomaly.id), input, ADMIN_ID)]);
    assert.equal(results.filter(result => result.replayed).length, 1);
    const after = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    assert.equal(after.balance.toFixed(2), '200000.00');
    assert.equal(after.heldBalance.toFixed(2), '150000.00');
    assert.deepEqual(await prisma.ledgerEntry.findMany({ where: { walletId: wallet.id } }), before);
    assert.equal(await prisma.anomalyAdjustment.count({ where: { anomalyId: anomaly.id } }), 1);
  } finally {
    await prisma.anomalyAdjustment.deleteMany({ where: { anomalyId: anomaly.id } });
    await prisma.reconciliationReport.delete({ where: { id: report.id } });
    // Ledger rows are append-only. The test runner drops its disposable test
    // database; do not disable triggers or delete historical money entries.
  }
});

test('K17-4: W4 Phân quyền - 401 khi thiếu token, 403 khi USER, 404 khi không tìm thấy anomaly', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Không có token -> 401
    const noTokenRes = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/anomalies/1/adjust`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Điều chỉnh số dư kiểm toán' }),
    });
    assert.equal(noTokenRes.status, 401);

    // 2. Token USER -> 403
    const userRes = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/anomalies/1/adjust`, {
      method: 'POST',
      headers: {
        'x-gateway-token': userToken(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'Điều chỉnh số dư kiểm toán' }),
    });
    assert.equal(userRes.status, 403);

    // 3. Anomaly không tồn tại -> 404 ANOMALY_NOT_FOUND
    const notFoundRes = await fetch(
      `${baseUrl}/api/wallets/admin/reconciliation/anomalies/99999999/adjust`,
      {
        method: 'POST',
        headers: {
          'x-gateway-token': adminToken(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason: 'Điều chỉnh số dư kiểm toán' }),
      }
    );
    assert.equal(notFoundRes.status, 404);
    const notFoundJson = await notFoundRes.json();
    assert.equal(notFoundJson.error.code, 'ANOMALY_NOT_FOUND');
  } finally {
    server.close();
  }
});

test('K17-4: W4 Ràng buộc lý do - Thiếu, rỗng, chỉ khoảng trắng hoặc dưới 5 ký tự trả 400 REASON_REQUIRED; trên 500 ký tự trả 400 INVALID_REASON', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const invalidBodies = [
      {},
      { reason: '' },
      { reason: '         ' },
      { reason: 'quá' }, // 3 ký tự
      { reason: 'abcd' }, // 4 ký tự
    ];

    for (const body of invalidBodies) {
      const res = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/anomalies/1/adjust`, {
        method: 'POST',
        headers: {
          'x-gateway-token': adminToken(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, `Body ${JSON.stringify(body)} phải trả 400`);
      const json = await res.json();
      assert.equal(json.error.code, 'REASON_REQUIRED');
    }

    // Kiểm tra biên 501 ký tự -> 400 INVALID_REASON
    const resOver500 = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/anomalies/1/adjust`, {
      method: 'POST',
      headers: {
        'x-gateway-token': adminToken(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'a'.repeat(501) }),
    });
    assert.equal(resOver500.status, 400);
    const jsonOver500 = await resOver500.json();
    assert.equal(jsonOver500.error.code, 'INVALID_REASON');

    // Các giá trị biên hợp lệ (5, 9, 10, 500 ký tự) không bị lỗi REASON_REQUIRED/INVALID_REASON
    // (chúng sẽ đi qua bước kiểm tra reason và chạm tới bước kiểm tra anomaly 404 ANOMALY_NOT_FOUND)
    const validBoundaries = [
      '12345',            // 5 ký tự (biên dưới)
      '123456789',        // 9 ký tự (trước đây bị chặn >= 10, nay hợp lệ theo contract 5-500)
      '1234567890',       // 10 ký tự
      'a'.repeat(500),    // 500 ký tự (biên trên)
    ];

    for (const reason of validBoundaries) {
      const res = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/anomalies/99999999/adjust`, {
        method: 'POST',
        headers: {
          'x-gateway-token': adminToken(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason }),
      });
      assert.equal(res.status, 404, `Reason độ dài ${reason.length} phải qua bước validate lý do và trả 404`);
      const json = await res.json();
      assert.equal(json.error.code, 'ANOMALY_NOT_FOUND');
    }
  } finally {
    server.close();
  }
});

test('K17-4: W4 Ràng buộc direction và amount - Kiểm tra cú pháp hợp lệ', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Direction không hợp lệ -> 400 INVALID_DIRECTION
    for (const badDir of ['UP', 'DOWN', 'credit', 'debit', '123']) {
      const res = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/anomalies/1/adjust`, {
        method: 'POST',
        headers: {
          'x-gateway-token': adminToken(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reason: 'Lý do hợp lệ để test direction',
          direction: badDir,
        }),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error.code, 'INVALID_DIRECTION');
    }

    // 2. Amount không hợp lệ -> 400 INVALID_AMOUNT
    for (const badAmount of ['0', '-100', 'abc', 50000, '10.999']) {
      const res = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/anomalies/1/adjust`, {
        method: 'POST',
        headers: {
          'x-gateway-token': adminToken(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reason: 'Lý do hợp lệ để test amount',
          direction: 'CREDIT',
          amount: badAmount,
        }),
      });
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.error.code, 'INVALID_AMOUNT');
    }
  } finally {
    server.close();
  }
});

test('K17-4: W4 Chỉ hỗ trợ loại BALANCE_DRIFT; loại khác (NEGATIVE_BALANCE) trả 422 ADJUST_NOT_SUPPORTED', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const report = await prisma.reconciliationReport.create({
    data: {
      mode: 'QUICK',
      totalWallets: 1,
      anomaliesFound: 1,
      systemBalanceExpected: 0,
      systemBalanceActual: 0,
      isBalanced: false,
    },
  });

  const negAnomaly = await prisma.reconciliationAnomaly.create({
    data: {
      reportId: report.id,
      type: AnomalyType.NEGATIVE_BALANCE,
      walletId: 1,
      expected: '0.00',
      actual: '-10000.00',
      difference: '-10000.00',
      detail: {},
    },
  });

  try {
    const res = await fetch(
      `${baseUrl}/api/wallets/admin/reconciliation/anomalies/${negAnomaly.id}/adjust`,
      {
        method: 'POST',
        headers: {
          'x-gateway-token': adminToken(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason: 'Yêu cầu bù âm ví người dùng' }),
      }
    );
    assert.equal(res.status, 422);
    const json = await res.json();
    assert.equal(json.error.code, 'ADJUST_NOT_SUPPORTED');
  } finally {
    await prisma.reconciliationAnomaly.delete({ where: { id: negAnomaly.id } }).catch(() => {});
    await prisma.reconciliationReport.delete({ where: { id: report.id } }).catch(() => {});
    server.close();
  }
});

test('K17-4: W4 Điều chỉnh thành công BALANCE_DRIFT: ví về số dư kỳ vọng, anomaly RESOLVED, có AnomalyAdjustment, LedgerEntry bất biến', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // 1. Tạo ví và ghi nhận một bút toán sổ cái hợp lệ 200000.00đ
  const testUserId = randomUUID();
  const wallet = await prisma.wallet.create({
    data: {
      userId: testUserId,
      balance: 200000,
      heldBalance: 0,
      currency: 'VND',
      ownerType: OwnerType.USER,
      kycTier: 1,
    },
  });

  const txId = randomUUID();
  await prisma.ledgerEntry.create({
    data: {
      transactionId: txId,
      walletId: wallet.id,
      direction: 'CREDIT',
      amount: 200000,
      balanceAfter: 200000,
      referenceId: `seed_adjust_${randomUUID()}`,
      transferType: 'TOPUP',
    },
  });

  // 2. Cố ý làm lệch ví: sửa tay Wallet.balance thành 350000.00 (+150000đ)
  await prisma.wallet.update({
    where: { id: wallet.id },
    data: { balance: 350000 },
  });

  // 3. Chạy đối soát để phát hiện ra anomaly
  const scanRes = await fetch(`${baseUrl}/api/wallets/admin/reconciliation?mode=full`, {
    headers: { 'x-gateway-token': adminToken() },
  });
  assert.equal(scanRes.status, 200);
  const scanJson = await scanRes.json();

  const driftAnomaly = scanJson.data.anomalies.find((a: any) => a.walletId === wallet.id);
  assert.ok(driftAnomaly, 'Phải phát hiện bất thường drift trên ví');
  assert.equal(driftAnomaly.status, 'OPEN');
  assert.equal(driftAnomaly.expected, '200000.00');
  assert.equal(driftAnomaly.actual, '350000.00');
  assert.equal(driftAnomaly.difference, '150000.00');

  // Snapshot LedgerEntry trước khi gọi adjust để xác minh tính bất biến
  const ledgerCountBefore = await prisma.ledgerEntry.count({ where: { walletId: wallet.id } });
  const ledgerEntriesBefore = await prisma.ledgerEntry.findMany({ where: { walletId: wallet.id } });

  try {
    // 4.1. Kiểm tra mismatch semantic direction và amount trước khi điều chỉnh thành công
    // 4.1a. Drift là +150.000đ (thực tế > sổ cái -> cần DEBIT), nếu gửi CREDIT -> 400 DIRECTION_MISMATCH
    const dirMismatchRes = await fetch(
      `${baseUrl}/api/wallets/admin/reconciliation/anomalies/${driftAnomaly.id}/adjust`,
      {
        method: 'POST',
        headers: {
          'x-gateway-token': adminToken(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          direction: 'CREDIT',
          amount: '150000',
          reason: 'Gửi sai hướng điều chỉnh',
        }),
      }
    );
    assert.equal(dirMismatchRes.status, 400);
    const dirMismatchJson = await dirMismatchRes.json();
    assert.equal(dirMismatchJson.error.code, 'DIRECTION_MISMATCH');

    // 4.1b. Gửi sai số tiền (100.000 thay vì 150.000) -> 400 AMOUNT_MISMATCH
    const amtMismatchRes = await fetch(
      `${baseUrl}/api/wallets/admin/reconciliation/anomalies/${driftAnomaly.id}/adjust`,
      {
        method: 'POST',
        headers: {
          'x-gateway-token': adminToken(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          direction: 'DEBIT',
          amount: '100000',
          reason: 'Gửi sai số tiền cần điều chỉnh',
        }),
      }
    );
    assert.equal(amtMismatchRes.status, 400);
    const amtMismatchJson = await amtMismatchRes.json();
    assert.equal(amtMismatchJson.error.code, 'AMOUNT_MISMATCH');

    // 4.2. Gọi W4 điều chỉnh bất thường chuẩn theo contract Admin (đầy đủ direction, amount, referenceId, reason)
    const expectedRefId = `adjust-anomaly-${driftAnomaly.id}`;
    const adjustRes = await fetch(
      `${baseUrl}/api/wallets/admin/reconciliation/anomalies/${driftAnomaly.id}/adjust`,
      {
        method: 'POST',
        headers: {
          'x-gateway-token': adminToken(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          direction: 'DEBIT',
          amount: '150000',
          reason: 'Đồng bộ lại số dư ví theo số liệu sổ cái kiểm toán',
          referenceId: expectedRefId,
        }),
      }
    );
    assert.equal(adjustRes.status, 200);
    const adjustJson = await adjustRes.json();
    assert.equal(adjustJson.success, true);
    assert.equal(adjustJson.data.status, 'RESOLVED');
    assert.equal(adjustJson.data.replayed, false);
    assert.equal(adjustJson.data.transactionId, null);
    assert.equal(adjustJson.data.referenceId, expectedRefId);
    assert.equal(adjustJson.data.walletId, wallet.id);
    assert.equal(adjustJson.data.expectedBalance, '200000.00');
    assert.equal(adjustJson.data.actualBalance, '200000.00');
    assert.equal(adjustJson.data.delta, '150000.00');
    assert.ok(adjustJson.data.adjustment);
    assert.equal(adjustJson.data.adjustment.adminId, ADMIN_ID);
    assert.equal(adjustJson.data.adjustment.referenceId, expectedRefId);

    // 5. Kiểm tra ví: balance đã về đúng 200000.00
    const walletAfter = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    assert.equal(walletAfter.balance.toFixed(2), '200000.00');

    // 6. Kiểm tra Anomaly trong DB: status = RESOLVED
    const anomalyInDb = await prisma.reconciliationAnomaly.findUniqueOrThrow({
      where: { id: BigInt(driftAnomaly.id) },
    });
    assert.equal(anomalyInDb.status, 'RESOLVED');
    assert.equal(anomalyInDb.resolvedBy, ADMIN_ID);
    assert.ok(anomalyInDb.resolvedAt);
    assert.equal(anomalyInDb.adjustmentReferenceId, expectedRefId);

    // 7. Kiểm tra AnomalyAdjustment trong DB
    const adjInDb = await prisma.anomalyAdjustment.findUniqueOrThrow({
      where: { anomalyId: BigInt(driftAnomaly.id) },
    });
    assert.equal(adjInDb.walletId, wallet.id);
    assert.equal(adjInDb.delta.toFixed(2), '150000.00');
    assert.equal(adjInDb.referenceId, expectedRefId);

    // 8. TUYỆT ĐỐI không có LedgerEntry nào bị UPDATE/DELETE/INSERT
    const ledgerCountAfter = await prisma.ledgerEntry.count({ where: { walletId: wallet.id } });
    const ledgerEntriesAfter = await prisma.ledgerEntry.findMany({ where: { walletId: wallet.id } });
    assert.equal(ledgerCountAfter, ledgerCountBefore, 'Số lượng LedgerEntry không đổi');
    assert.equal(ledgerEntriesAfter[0].id, ledgerEntriesBefore[0].id);
    assert.equal(ledgerEntriesAfter[0].amount.toFixed(2), ledgerEntriesBefore[0].amount.toFixed(2));

    // 9. Đối soát lại: ví này không còn bất kỳ drift nào
    const rescan = await fetch(`${baseUrl}/api/wallets/admin/reconciliation?mode=full`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    const rescanJson = await rescan.json();
    const driftRescan = rescanJson.data.anomalies.find((a: any) => a.walletId === wallet.id);
    assert.equal(driftRescan, undefined, 'Đối soát lại sạch, không còn thấy anomaly trên ví');

    // 10. Idempotency: Gọi lại cùng anomalyId và cùng referenceId -> trả kết quả cũ (replayed = true), không đổi số dư lần 2
    const replayRes = await fetch(
      `${baseUrl}/api/wallets/admin/reconciliation/anomalies/${driftAnomaly.id}/adjust`,
      {
        method: 'POST',
        headers: {
          'x-gateway-token': adminToken(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          direction: 'DEBIT',
          amount: '150000',
          reason: 'Đồng bộ lại số dư ví theo số liệu sổ cái kiểm toán (gọi lại)',
          referenceId: expectedRefId,
        }),
      }
    );
    assert.equal(replayRes.status, 200);
    const replayJson = await replayRes.json();
    assert.equal(replayJson.success, true);
    assert.equal(replayJson.data.replayed, true);
    assert.equal(replayJson.data.status, 'RESOLVED');
    assert.equal(replayJson.data.transactionId, null);
    assert.equal(replayJson.data.referenceId, expectedRefId);

    const walletAfterReplay = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    assert.equal(walletAfterReplay.balance.toFixed(2), '200000.00', 'Số dư ví vẫn giữ nguyên');
    const adjCount = await prisma.anomalyAdjustment.count({
      where: { anomalyId: BigInt(driftAnomaly.id) },
    });
    assert.equal(adjCount, 1, 'Không ghi thêm bản ghi điều chỉnh thứ hai');

    // 11. Gọi lại với referenceId KHÁC trên anomaly đã RESOLVED -> 409 ALREADY_ADJUSTED
    const diffRefRes = await fetch(
      `${baseUrl}/api/wallets/admin/reconciliation/anomalies/${driftAnomaly.id}/adjust`,
      {
        method: 'POST',
        headers: {
          'x-gateway-token': adminToken(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          direction: 'DEBIT',
          amount: '150000',
          reason: 'Cố ý gửi referenceId khác',
          referenceId: 'different-reference-id-12345',
        }),
      }
    );
    assert.equal(diffRefRes.status, 409);
    const diffRefJson = await diffRefRes.json();
    assert.equal(diffRefJson.error.code, 'ALREADY_ADJUSTED');
  } finally {
    await prisma.anomalyAdjustment.deleteMany({ where: { walletId: wallet.id } });
    await prisma.reconciliationAnomaly.deleteMany({ where: { walletId: wallet.id } });
    await prisma.wallet.delete({ where: { id: wallet.id } }).catch(() => {});
    server.close();
  }
});

test('K17-4: W4 Concurrency - 2 request đồng thời vào cùng một anomaly -> đúng 1 lần điều chỉnh duy nhất', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const testUserId = randomUUID();
  const wallet = await prisma.wallet.create({
    data: {
      userId: testUserId,
      balance: 100000,
      heldBalance: 0,
      currency: 'VND',
      ownerType: OwnerType.USER,
      kycTier: 1,
    },
  });

  const txId = randomUUID();
  await prisma.ledgerEntry.create({
    data: {
      transactionId: txId,
      walletId: wallet.id,
      direction: 'CREDIT',
      amount: 100000,
      balanceAfter: 100000,
      referenceId: `seed_conc_${randomUUID()}`,
      transferType: 'TOPUP',
    },
  });

  // Làm lệch ví
  await prisma.wallet.update({
    where: { id: wallet.id },
    data: { balance: 180000 },
  });

  const scanRes = await fetch(`${baseUrl}/api/wallets/admin/reconciliation?mode=quick`, {
    headers: { 'x-gateway-token': adminToken() },
  });
  const scanJson = await scanRes.json();
  const drift = scanJson.data.anomalies.find((a: any) => a.walletId === wallet.id);
  assert.ok(drift);

  try {
    // 2 request đồng thời
    const callAdjust = () =>
      fetch(`${baseUrl}/api/wallets/admin/reconciliation/anomalies/${drift.id}/adjust`, {
        method: 'POST',
        headers: {
          'x-gateway-token': adminToken(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reason: 'Xử lý bất thường song song kiểm thử tương tranh',
        }),
      }).then(r => r.json());

    const [res1, res2] = await Promise.all([callAdjust(), callAdjust()]);

    // Cả 2 request đều thành công (1 thực hiện điều chỉnh chính thức, 1 replayed)
    assert.equal(res1.success, true);
    assert.equal(res2.success, true);

    const replayedCount = (res1.data.replayed ? 1 : 0) + (res2.data.replayed ? 1 : 0);
    assert.equal(replayedCount, 1, 'Đúng 1 request thực hiện và 1 request replayed');

    // Duy nhất 1 bản ghi AnomalyAdjustment trong DB
    const adjCount = await prisma.anomalyAdjustment.count({
      where: { anomalyId: BigInt(drift.id) },
    });
    assert.equal(adjCount, 1, 'Chỉ duy nhất 1 bản ghi điều chỉnh được lưu trong DB');

    // Ví về đúng 100000.00
    const finalWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    assert.equal(finalWallet.balance.toFixed(2), '100000.00');
  } finally {
    await prisma.anomalyAdjustment.deleteMany({ where: { walletId: wallet.id } });
    await prisma.reconciliationAnomaly.deleteMany({ where: { walletId: wallet.id } });
    await prisma.wallet.delete({ where: { id: wallet.id } }).catch(() => {});
    server.close();
  }
});
