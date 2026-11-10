import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient, AnomalyType } from '@prisma/client';
import { createTestGatewayToken } from 'finvault-internal-auth';

const prisma = new PrismaClient();

const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';

const adminToken = () => createTestGatewayToken(ADMIN_ID, 'ADMIN');
const userToken = () => createTestGatewayToken(USER_ID, 'USER');

test('K17-3: W3 Phân quyền - 401 khi thiếu token, 403 khi USER, 200 khi ADMIN', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const report = await prisma.reconciliationReport.create({
    data: {
      mode: 'QUICK',
      totalWallets: 5,
      anomaliesFound: 0,
      systemBalanceExpected: 0,
      systemBalanceActual: 0,
      isBalanced: true,
    },
  });

  try {
    // 1. Thiếu token -> 401
    const noTokenRes = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/reports/${report.id}`);
    assert.equal(noTokenRes.status, 401);

    // 2. Token USER -> 403
    const userRes = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/reports/${report.id}`, {
      headers: { 'x-gateway-token': userToken() },
    });
    assert.equal(userRes.status, 403);

    // 3. Token ADMIN -> 200
    const adminRes = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/reports/${report.id}`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(adminRes.status, 200);
    const json = await adminRes.json();
    assert.equal(json.success, true);
    assert.equal(json.data.id, report.id);

    // 4. Đường dẫn trực tiếp /reconciliation/reports/:id cũng hoạt động
    const directRes = await fetch(`${baseUrl}/reconciliation/reports/${report.id}`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(directRes.status, 200);
  } finally {
    await prisma.reconciliationReport.delete({ where: { id: report.id } }).catch(() => {});
    server.close();
  }
});

test('K17-3: W3 Chi tiết báo cáo - Có anomalies và không có anomalies, định dạng tiền chuẩn dự án', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // Báo cáo 1: Có anomaly
  const reportWithAnom = await prisma.reconciliationReport.create({
    data: {
      mode: 'FULL',
      totalWallets: 12,
      anomaliesFound: 1,
      systemBalanceExpected: '0.00',
      systemBalanceActual: '50000.00',
      isBalanced: false,
      anomalies: {
        create: [
          {
            type: AnomalyType.BALANCE_DRIFT_FULL,
            walletId: 999999,
            expected: '100000.00',
            actual: '150000.00',
            difference: '50000.00',
            detail: { mode: 'FULL', diff: '50000.00' },
          },
        ],
      },
    },
    include: { anomalies: true },
  });

  // Báo cáo 2: Không có anomaly
  const reportClean = await prisma.reconciliationReport.create({
    data: {
      mode: 'QUICK',
      totalWallets: 8,
      anomaliesFound: 0,
      systemBalanceExpected: '0.00',
      systemBalanceActual: '0.00',
      isBalanced: true,
    },
  });

  try {
    // 1. Kiểm tra báo cáo có anomaly
    const res1 = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/reports/${reportWithAnom.id}`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(res1.status, 200);
    const json1 = await res1.json();
    assert.equal(json1.success, true);
    assert.equal(json1.data.id, reportWithAnom.id);
    assert.equal(json1.data.mode, 'FULL');
    assert.equal(json1.data.isBalanced, false);
    assert.equal(json1.data.anomaliesFound, 1);
    assert.equal(json1.data.systemBalanceExpected, '0.00');
    assert.equal(json1.data.systemBalanceActual, '50000.00');
    assert.equal(json1.data.totalBalance, '50000.00');
    assert.equal(json1.data.anomalies.length, 1);

    const anom = json1.data.anomalies[0];
    assert.equal(anom.type, 'BALANCE_DRIFT');
    assert.equal(anom.mode, 'FULL');
    assert.equal(anom.walletId, 999999);
    assert.equal(anom.expected, '100000.00');
    assert.equal(anom.actual, '150000.00');
    assert.equal(anom.difference, '50000.00');
    assert.equal(anom.status, 'OPEN');
    assert.ok(typeof anom.id === 'string');
    assert.ok(anom.detectedAt);

    // 2. Kiểm tra báo cáo sạch không có anomaly
    const res2 = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/reports/${reportClean.id}`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(res2.status, 200);
    const json2 = await res2.json();
    assert.equal(json2.success, true);
    assert.equal(json2.data.id, reportClean.id);
    assert.equal(json2.data.isBalanced, true);
    assert.equal(json2.data.anomaliesFound, 0);
    assert.deepEqual(json2.data.anomalies, []);
  } finally {
    await prisma.reconciliationAnomaly.deleteMany({ where: { reportId: reportWithAnom.id } });
    await prisma.reconciliationReport.deleteMany({
      where: { id: { in: [reportWithAnom.id, reportClean.id] } },
    });
    server.close();
  }
});

test('K17-3: W3 Báo cáo không tồn tại -> 404 REPORT_NOT_FOUND, Id sai định dạng -> 400 INVALID_REPORT_ID', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Id không tồn tại -> 404 REPORT_NOT_FOUND
    const notFoundRes = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/reports/99999999`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(notFoundRes.status, 404);
    const notFoundJson = await notFoundRes.json();
    assert.equal(notFoundJson.error.code, 'REPORT_NOT_FOUND');

    // 2. Id là chữ (abc) -> 400 INVALID_REPORT_ID
    const badIdRes1 = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/reports/abc`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(badIdRes1.status, 400);
    const badIdJson1 = await badIdRes1.json();
    assert.equal(badIdJson1.error.code, 'INVALID_REPORT_ID');

    // 3. Id âm (-5) -> 400 INVALID_REPORT_ID
    const badIdRes2 = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/reports/-5`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(badIdRes2.status, 400);
    const badIdJson2 = await badIdRes2.json();
    assert.equal(badIdJson2.error.code, 'INVALID_REPORT_ID');
  } finally {
    server.close();
  }
});
