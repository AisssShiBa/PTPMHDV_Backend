import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient, OwnerType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { createTestGatewayToken } from 'finvault-internal-auth';

const prisma = new PrismaClient();

const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const adminToken = () => createTestGatewayToken(ADMIN_ID, 'ADMIN');

test('K17-5: openapi.json chứa đầy đủ định nghĩa hợp đồng W1-W4 và schemas tương ứng', () => {
  const openapiPath = path.resolve(__dirname, '../docs/openapi.json');
  assert.ok(fs.existsSync(openapiPath), 'File openapi.json phải tồn tại');

  const content = fs.readFileSync(openapiPath, 'utf-8');
  let openapi: any;
  assert.doesNotThrow(() => {
    openapi = JSON.parse(content);
  }, 'File openapi.json phải là JSON hợp lệ');

  // 1. Kiểm tra 4 endpoint W1-W4
  assert.ok(openapi.paths['/wallets/admin/reconciliation']?.get, 'Phải có W1 GET /wallets/admin/reconciliation');
  assert.ok(openapi.paths['/wallets/admin/reconciliation/reports']?.get, 'Phải có W2 GET /wallets/admin/reconciliation/reports');
  assert.ok(openapi.paths['/wallets/admin/reconciliation/reports/{id}']?.get, 'Phải có W3 GET /wallets/admin/reconciliation/reports/{id}');
  assert.ok(openapi.paths['/wallets/admin/reconciliation/anomalies/{id}/adjust']?.post, 'Phải có W4 POST /wallets/admin/reconciliation/anomalies/{id}/adjust');

  // 2. Kiểm tra schemas components
  const schemas = openapi.components?.schemas;
  assert.ok(schemas?.ReconciliationAnomaly, 'Phải có schema ReconciliationAnomaly');
  assert.ok(schemas?.ReconciliationReport, 'Phải có schema ReconciliationReport');
  assert.ok(schemas?.ReconciliationReportResponse, 'Phải có schema ReconciliationReportResponse');
  assert.ok(schemas?.ReconciliationReportListResponse, 'Phải có schema ReconciliationReportListResponse');
  assert.ok(schemas?.AdjustAnomalyRequest, 'Phải có schema AdjustAnomalyRequest');
  assert.ok(schemas?.AdjustAnomalyResponse, 'Phải có schema AdjustAnomalyResponse');
});

test('K17-5: Validate response thực tế của W1-W4 khớp 100% với schema OpenAPI', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const openapiPath = path.resolve(__dirname, '../docs/openapi.json');
  const openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf-8'));
  const reportSchema = openapi.components.schemas.ReconciliationReport;
  const anomalySchema = openapi.components.schemas.ReconciliationAnomaly;
  const adjustDataSchema = openapi.components.schemas.AdjustAnomalyData;

  // Tạo dữ liệu test
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
      referenceId: `seed_contract_${randomUUID()}`,
      transferType: 'TOPUP',
    },
  });

  // Gây lệch số dư để có anomaly test
  await prisma.wallet.update({
    where: { id: wallet.id },
    data: { balance: 160000 },
  });

  try {
    // Test W1 Response
    const w1Res = await fetch(`${baseUrl}/api/wallets/admin/reconciliation?mode=quick`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(w1Res.status, 200);
    const w1Json = await w1Res.json();
    assert.equal(w1Json.success, true);
    for (const prop of reportSchema.required) {
      assert.ok(w1Json.data[prop] !== undefined, `W1 data thiếu trường required: ${prop}`);
    }

    const testAnomaly = w1Json.data.anomalies.find((a: any) => a.walletId === wallet.id);
    assert.ok(testAnomaly, 'Phải có anomaly cho ví test');
    for (const prop of anomalySchema.required) {
      assert.ok(testAnomaly[prop] !== undefined, `Anomaly thiếu trường required: ${prop}`);
    }

    // Test W2 Response
    const w2Res = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/reports?limit=1`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(w2Res.status, 200);
    const w2Json = await w2Res.json();
    assert.equal(w2Json.success, true);
    assert.ok(Array.isArray(w2Json.data.items));
    assert.equal(typeof w2Json.data.total, 'number');

    // Test W3 Response
    const w3Res = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/reports/${w1Json.data.id}`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(w3Res.status, 200);
    const w3Json = await w3Res.json();
    assert.equal(w3Json.success, true);
    assert.equal(w3Json.data.id, w1Json.data.id);

    // Test W4 Response
    const w4Res = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/anomalies/${testAnomaly.id}/adjust`, {
      method: 'POST',
      headers: {
        'x-gateway-token': adminToken(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'Điều chỉnh số dư ví theo hợp đồng OpenAPI' }),
    });
    assert.equal(w4Res.status, 200);
    const w4Json = await w4Res.json();
    assert.equal(w4Json.success, true);
    for (const prop of adjustDataSchema.required) {
      assert.ok(w4Json.data[prop] !== undefined, `W4 data thiếu trường required: ${prop}`);
    }
    assert.equal(w4Json.data.status, 'RESOLVED');
  } finally {
    await prisma.anomalyAdjustment.deleteMany({ where: { walletId: wallet.id } });
    await prisma.reconciliationAnomaly.deleteMany({ where: { walletId: wallet.id } });
    await prisma.wallet.delete({ where: { id: wallet.id } }).catch(() => {});
    server.close();
  }
});
