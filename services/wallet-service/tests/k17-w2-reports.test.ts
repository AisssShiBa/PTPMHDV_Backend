import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';
import { createTestGatewayToken } from 'finvault-internal-auth';

const prisma = new PrismaClient();

const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';

const adminToken = () => createTestGatewayToken(ADMIN_ID, 'ADMIN');
const userToken = () => createTestGatewayToken(USER_ID, 'USER');

test('K17-2: W2 Phân quyền - 401 khi thiếu token, 403 khi USER, 200 khi ADMIN', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Thiếu token -> 401
    const noTokenRes = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/reports`);
    assert.equal(noTokenRes.status, 401);

    // 2. Token USER -> 403
    const userRes = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/reports`, {
      headers: { 'x-gateway-token': userToken() },
    });
    assert.equal(userRes.status, 403);

    // 3. Token ADMIN -> 200
    const adminRes = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/reports`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(adminRes.status, 200);
    const json = await adminRes.json();
    assert.equal(json.success, true);
    assert.ok(Array.isArray(json.data.items));

    // 4. Đường dẫn trực tiếp /reconciliation/reports cũng hoạt động
    const directRes = await fetch(`${baseUrl}/reconciliation/reports`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(directRes.status, 200);
  } finally {
    server.close();
  }
});

test('K17-2: W2 Phân trang cursor - Không trùng không sót, mới nhất trước, xử lý cursor và limit', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // Đảm bảo có ít nhất 5 báo cáo để kiểm tra phân trang
  for (let i = 0; i < 5; i++) {
    await prisma.reconciliationReport.create({
      data: {
        mode: i % 2 === 0 ? 'QUICK' : 'FULL',
        totalWallets: 10 + i,
        anomaliesFound: 0,
        systemBalanceExpected: 0,
        systemBalanceActual: 0,
        isBalanced: true,
      },
    });
  }

  try {
    // 1. Trang 1 với limit = 2
    const page1Res = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/reports?limit=2`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(page1Res.status, 200);
    const page1 = await page1Res.json();
    assert.equal(page1.data.items.length, 2);
    assert.ok(page1.data.nextCursor, 'Phải có nextCursor khi còn dữ liệu');

    // Kiểm tra thứ tự mới nhất trước (runAt giảm dần, id giảm dần)
    const [p1Item1, p1Item2] = page1.data.items;
    const time1 = new Date(p1Item1.runAt).getTime();
    const time2 = new Date(p1Item2.runAt).getTime();
    assert.ok(time1 >= time2);
    if (time1 === time2) {
      assert.ok(p1Item1.id > p1Item2.id);
    }

    // 2. Trang 2 dùng nextCursor
    const page2Res = await fetch(
      `${baseUrl}/api/wallets/admin/reconciliation/reports?limit=2&cursor=${page1.data.nextCursor}`,
      { headers: { 'x-gateway-token': adminToken() } }
    );
    assert.equal(page2Res.status, 200);
    const page2 = await page2Res.json();
    assert.equal(page2.data.items.length, 2);

    // Không trùng id giữa trang 1 và trang 2
    const p1Ids = new Set(page1.data.items.map((i: any) => i.id));
    for (const item of page2.data.items) {
      assert.ok(!p1Ids.has(item.id), `Id ${item.id} không được trùng lặp giữa các trang`);
    }

    // 3. Limit không hợp lệ -> 400 INVALID_LIMIT
    const badLimitRes1 = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/reports?limit=-5`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(badLimitRes1.status, 400);
    const badLimitJson1 = await badLimitRes1.json();
    assert.equal(badLimitJson1.error.code, 'INVALID_LIMIT');

    const badLimitRes2 = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/reports?limit=abc`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(badLimitRes2.status, 400);

    // 4. Cursor rác / sai định dạng -> 400 INVALID_CURSOR
    const badCursorRes1 = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/reports?cursor=not_a_valid_cursor`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(badCursorRes1.status, 400);
    const badCursorJson1 = await badCursorRes1.json();
    assert.equal(badCursorJson1.error.code, 'INVALID_CURSOR');

    const invalidJsonCursor = Buffer.from(JSON.stringify({ runAt: 'invalid-date', id: 'abc' })).toString('base64url');
    const badCursorRes2 = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/reports?cursor=${invalidJsonCursor}`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(badCursorRes2.status, 400);
    const badCursorJson2 = await badCursorRes2.json();
    assert.equal(badCursorJson2.error.code, 'INVALID_CURSOR');

    // 5. Limit trần cấu hình: limit lớn (ví dụ 500) được áp trần tối đa 100
    const highLimitRes = await fetch(`${baseUrl}/api/wallets/admin/reconciliation/reports?limit=500`, {
      headers: { 'x-gateway-token': adminToken() },
    });
    assert.equal(highLimitRes.status, 200);
    const highLimitJson = await highLimitRes.json();
    assert.equal(highLimitJson.data.limit, 100);
  } finally {
    server.close();
  }
});
