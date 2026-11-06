import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient, OwnerType, TransferType, LedgerDirection } from '@prisma/client';
import { randomUUID } from 'crypto';
import { createTestGatewayToken } from 'finvault-internal-auth';
import { encodeCursor } from '../src/utils/cursor.helper';

const prisma = new PrismaClient();

async function createTestWalletWithLedger(entriesCount: number) {
  const userId = randomUUID();
  const wallet = await prisma.wallet.create({
    data: {
      userId,
      balance: entriesCount * 10000,
      heldBalance: 0,
      currency: 'VND',
      ownerType: OwnerType.USER,
      kycTier: 2,
    },
  });

  const baseTime = Date.now() - entriesCount * 1000;
  const createdEntries = [];

  for (let i = 0; i < entriesCount; i++) {
    const entryDate = new Date(baseTime + i * 1000);
    const entry = await prisma.ledgerEntry.create({
      data: {
        transactionId: randomUUID(),
        walletId: wallet.id,
        direction: LedgerDirection.CREDIT,
        amount: 10000,
        balanceAfter: (i + 1) * 10000,
        referenceId: `ref_entry_${wallet.id}_${i}_${randomUUID()}`,
        transferType: TransferType.TOPUP,
        note: `Bút toán thứ ${i + 1}`,
        createdAt: entryDate,
      },
    });
    createdEntries.push(entry);
  }

  return { userId, wallet, entries: createdEntries };
}

test('K15-2 (1): Trang đầu trả đúng limit, có nextCursor và đúng thứ tự createdAt DESC, id DESC', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const { userId } = await createTestWalletWithLedger(25);
    const token = createTestGatewayToken(userId, 'USER');

    const res = await fetch(`${baseUrl}/api/wallets/me/ledger?limit=10`, {
      method: 'GET',
      headers: { 'x-gateway-token': token },
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.items.length, 10);
    assert.ok(json.data.nextCursor);
    assert.equal(typeof json.data.nextCursor, 'string');

    // Thứ tự giảm dần theo thời gian
    for (let i = 0; i < json.data.items.length - 1; i++) {
      const current = new Date(json.data.items[i].createdAt).getTime();
      const next = new Date(json.data.items[i + 1].createdAt).getTime();
      assert.ok(current >= next, 'CreatedAt phải sắp xếp giảm dần');
    }
  } finally {
    server.close();
  }
});

test('K15-2 (2): Dùng nextCursor lấy trang 2: phần tử đầu trang 2 liền sau phần tử cuối trang 1, không trùng không sót', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const { userId, wallet } = await createTestWalletWithLedger(25);
    const token = createTestGatewayToken(userId, 'USER');

    // Lấy trang 1
    const res1 = await fetch(`${baseUrl}/api/wallets/me/ledger?limit=10`, {
      method: 'GET',
      headers: { 'x-gateway-token': token },
    });
    const json1 = await res1.json();
    assert.equal(json1.data.items.length, 10);
    const cursor1 = json1.data.nextCursor;
    assert.ok(cursor1);

    // Lấy trang 2
    const res2 = await fetch(`${baseUrl}/api/wallets/me/ledger?limit=10&cursor=${cursor1}`, {
      method: 'GET',
      headers: { 'x-gateway-token': token },
    });
    const json2 = await res2.json();
    assert.equal(json2.data.items.length, 10);

    // Kiểm tra không trùng lặp
    const ids1 = new Set(json1.data.items.map((i: any) => i.id));
    for (const item of json2.data.items) {
      assert.ok(!ids1.has(item.id), `Phần tử ${item.id} không được trùng giữa 2 trang`);
    }

    // Truy vấn trực tiếp từ DB để kiểm tra phần tử đầu trang 2 phải đúng là phần tử thứ 11 trong DB
    const allDbEntries = await prisma.ledgerEntry.findMany({
      where: { walletId: wallet.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    assert.equal(json1.data.items[9].id, allDbEntries[9].id.toString());
    assert.equal(json2.data.items[0].id, allDbEntries[10].id.toString(), 'Đầu trang 2 phải liền sau cuối trang 1');
  } finally {
    server.close();
  }
});

test('K15-2 (3): Duyệt hết toàn bộ ledger của 1 user có >= 50 bản ghi, tập ID gom được khớp đúng 100% với DB', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const totalEntries = 55;
    const { userId, wallet } = await createTestWalletWithLedger(totalEntries);
    const token = createTestGatewayToken(userId, 'USER');

    const collectedIds: string[] = [];
    let currentCursor: string | null = null;
    let pageCount = 0;

    while (true) {
      pageCount++;
      const url = currentCursor
        ? `${baseUrl}/api/wallets/me/ledger?limit=15&cursor=${currentCursor}`
        : `${baseUrl}/api/wallets/me/ledger?limit=15`;

      const res = await fetch(url, {
        headers: { 'x-gateway-token': token },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.success, true);

      for (const item of json.data.items) {
        collectedIds.push(item.id);
      }

      if (!json.data.nextCursor) {
        break;
      }
      currentCursor = json.data.nextCursor;
      assert.ok(pageCount <= 10, 'Tránh vòng lặp vô hạn nếu phân trang lỗi');
    }

    // Đối chiếu với truy vấn DB
    const expectedDbEntries = await prisma.ledgerEntry.findMany({
      where: { walletId: wallet.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const expectedIds = expectedDbEntries.map((e) => e.id.toString());
    assert.equal(collectedIds.length, totalEntries, 'Tổng số bản ghi gom được phải đủ 55');
    assert.deepEqual(collectedIds, expectedIds, 'Tập ID gom qua cursor phải khớp 100% thứ tự và giá trị DB');
  } finally {
    server.close();
  }
});

test('K15-2 (4): Chèn bản ghi mới có createdAt mới hơn khi đang giữ cursor trang 1 -> lấy trang 2 không bị trượt/lặp', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const { userId, wallet } = await createTestWalletWithLedger(30);
    const token = createTestGatewayToken(userId, 'USER');

    // Lấy trang 1
    const res1 = await fetch(`${baseUrl}/api/wallets/me/ledger?limit=10`, {
      headers: { 'x-gateway-token': token },
    });
    const json1 = await res1.json();
    const cursor1 = json1.data.nextCursor;

    // Giữa chừng chèn 1 bản ghi mới có createdAt mới hơn hẳn (tương lai)
    const newEntry = await prisma.ledgerEntry.create({
      data: {
        transactionId: randomUUID(),
        walletId: wallet.id,
        direction: LedgerDirection.CREDIT,
        amount: 99999,
        balanceAfter: 999999,
        referenceId: `concurrent_ref_${randomUUID()}`,
        transferType: TransferType.TOPUP,
        note: 'Bản ghi chèn giữa chừng',
        createdAt: new Date(Date.now() + 60000), // Thời gian mới hơn trang 1
      },
    });

    // Tiếp tục lấy trang 2 bằng cursor cũ
    const res2 = await fetch(`${baseUrl}/api/wallets/me/ledger?limit=10&cursor=${cursor1}`, {
      headers: { 'x-gateway-token': token },
    });
    const json2 = await res2.json();

    // Trang 2 không được chứa bản ghi mới chèn
    const page2Ids = json2.data.items.map((i: any) => i.id);
    assert.ok(!page2Ids.includes(newEntry.id.toString()), 'Trang 2 không được lẫn bản ghi mới hơn cursor');

    // Trang 2 không được trùng lặp với trang 1
    const page1Ids = json1.data.items.map((i: any) => i.id);
    for (const id of page2Ids) {
      assert.ok(!page1Ids.includes(id), 'Trang 2 không được trùng phần tử với trang 1');
    }
  } finally {
    server.close();
  }
});

test('K15-2 (5): Cursor bậy hoặc bị sửa đổi -> 400 INVALID_CURSOR; Limit không hợp lệ -> 400 INVALID_LIMIT', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const { userId } = await createTestWalletWithLedger(5);
    const token = createTestGatewayToken(userId, 'USER');

    // 1. Cursor chuỗi rác
    const resGarbage = await fetch(`${baseUrl}/api/wallets/me/ledger?cursor=not-a-valid-base64url`, {
      headers: { 'x-gateway-token': token },
    });
    assert.equal(resGarbage.status, 400);
    const jsonGarbage = await resGarbage.json();
    assert.equal(jsonGarbage.error.code, 'INVALID_CURSOR');

    // 2. Cursor JSON không hợp lệ (thiếu trường hoặc sai kiểu)
    const badJsonCursor = Buffer.from(JSON.stringify({ createdAt: 'invalid-date', id: 'abc' })).toString('base64url');
    const resBadJson = await fetch(`${baseUrl}/api/wallets/me/ledger?cursor=${badJsonCursor}`, {
      headers: { 'x-gateway-token': token },
    });
    assert.equal(resBadJson.status, 400);
    const jsonBadJson = await resBadJson.json();
    assert.equal(jsonBadJson.error.code, 'INVALID_CURSOR');

    // 3. Limit <= 0 hoặc không phải số
    const resBadLimit = await fetch(`${baseUrl}/api/wallets/me/ledger?limit=-5`, {
      headers: { 'x-gateway-token': token },
    });
    assert.equal(resBadLimit.status, 400);
    const jsonBadLimit = await resBadLimit.json();
    assert.equal(jsonBadLimit.error.code, 'INVALID_LIMIT');
  } finally {
    server.close();
  }
});

test('K15-2 (6): User A không thể đọc được ledger của User B (kể cả truyền cursor của bản ghi User B)', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const userA = await createTestWalletWithLedger(10);
    const userB = await createTestWalletWithLedger(10);

    const tokenA = createTestGatewayToken(userA.userId, 'USER');

    // Tạo cursor hợp lệ từ bản ghi của User B
    const userBCursor = encodeCursor(userB.entries[5]);

    // User A gọi /me/ledger với cursor của User B
    const res = await fetch(`${baseUrl}/api/wallets/me/ledger?cursor=${userBCursor}`, {
      headers: { 'x-gateway-token': tokenA },
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);

    // Mọi phần tử trả về đều phải thuộc User A
    const userAEntryIds = new Set(userA.entries.map((e) => e.id.toString()));
    const userBEntryIds = new Set(userB.entries.map((e) => e.id.toString()));

    for (const item of json.data.items) {
      assert.ok(userAEntryIds.has(item.id), 'Phần tử phải thuộc ví User A');
      assert.ok(!userBEntryIds.has(item.id), 'Tuyệt đối không được chứa bút toán của User B');
    }
  } finally {
    server.close();
  }
});

test('K15-2 (7): Không lộ walletId hoặc userId đối ứng trong response', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const { userId } = await createTestWalletWithLedger(5);
    const token = createTestGatewayToken(userId, 'USER');

    const res = await fetch(`${baseUrl}/api/wallets/me/ledger`, {
      headers: { 'x-gateway-token': token },
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);

    for (const item of json.data.items) {
      assert.equal(item.walletId, undefined, 'Không được trả walletId');
      assert.equal(item.userId, undefined, 'Không được trả userId');
      assert.equal(item.sourceWalletId, undefined, 'Không được trả sourceWalletId');
      assert.equal(item.destinationWalletId, undefined, 'Không được trả destinationWalletId');
      // Đảm bảo có các trường an toàn
      assert.ok(item.id);
      assert.ok(item.transactionId);
      assert.ok(item.direction);
      assert.ok(item.amount);
      assert.ok(item.balanceAfter);
      assert.ok(item.referenceId);
      assert.ok(item.transferType);
      assert.ok(item.createdAt);
    }
  } finally {
    server.close();
  }
});
