import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaClient, OwnerType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { createTestGatewayToken } from 'finvault-internal-auth';

const prisma = new PrismaClient();

const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const adminToken = () => createTestGatewayToken(ADMIN_ID, 'ADMIN');

/**
 * Phản ánh chính xác 100% hợp đồng WalletReconciliationClient trong admin-service
 * (services/admin-service/src/services/walletReconciliationClient.ts).
 */
export type WalletAnomaly = {
  id: string;
  reportId?: number;
  type: string;
  walletId?: number | null;
  transactionId?: string | null;
  detail?: unknown;
};

export type WalletReconciliationReport = {
  id: number;
  runAt?: string;
  totalWallets?: number;
  anomaliesFound?: number;
  systemBalanceExpected?: string;
  systemBalanceActual?: string;
  isBalanced: boolean;
  anomalies: WalletAnomaly[];
};

export type WalletReportPage = {
  items: WalletReconciliationReport[];
  page: number;
  limit: number;
  total: number;
};

export type WalletAdjustResult = {
  transactionId: string | null;
  replayed: boolean;
};

export type WalletRequestContext = {
  gatewayToken: string;
  requestId?: string;
};

export type AdjustAnomalyRequest = {
  direction: 'CREDIT' | 'DEBIT';
  amount: string;
  reason: string;
  referenceId: string;
};

export class WalletClientError extends Error {
  constructor(
    message: string,
    public readonly status: number | undefined,
    public readonly code: string | undefined,
    public readonly timedOut = false
  ) {
    super(message);
    this.name = 'WalletClientError';
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const asPositiveInt = (value: unknown): number | undefined => {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
};

const normalizeReport = (value: unknown): WalletReconciliationReport => {
  const record = asRecord(value);
  const id = asPositiveInt(record?.id);
  if (!record || id === undefined) {
    throw new WalletClientError('Wallet report is malformed', undefined, 'WALLET_BAD_RESPONSE');
  }
  const rawAnomalies = Array.isArray(record.anomalies) ? record.anomalies : [];
  return {
    id,
    runAt: typeof record.runAt === 'string' ? record.runAt : undefined,
    totalWallets: typeof record.totalWallets === 'number' ? record.totalWallets : undefined,
    anomaliesFound:
      typeof record.anomaliesFound === 'number' ? record.anomaliesFound : rawAnomalies.length,
    systemBalanceExpected:
      typeof record.systemBalanceExpected === 'string' ? record.systemBalanceExpected : undefined,
    systemBalanceActual:
      typeof record.systemBalanceActual === 'string' ? record.systemBalanceActual : undefined,
    isBalanced: record.isBalanced === true,
    anomalies: rawAnomalies.map(item => {
      const anomaly = asRecord(item) ?? {};
      return {
        id: String(anomaly.id ?? ''),
        reportId: typeof anomaly.reportId === 'number' ? anomaly.reportId : undefined,
        type: String(anomaly.type ?? 'UNKNOWN'),
        walletId: typeof anomaly.walletId === 'number' ? anomaly.walletId : null,
        transactionId: typeof anomaly.transactionId === 'string' ? anomaly.transactionId : null,
        detail: anomaly.detail,
      };
    }),
  };
};

export class WalletReconciliationClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 60_000
  ) {}

  private async request(
    path: string,
    context: WalletRequestContext,
    init: { method: 'GET' | 'POST'; body?: unknown } = { method: 'GET' }
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: {
          'x-gateway-token': context.gatewayToken,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(context.requestId === undefined ? {} : { 'x-request-id': context.requestId }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string } | undefined)?.name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      throw new WalletClientError(
        timedOut ? 'Wallet service did not respond in time' : 'Wallet service is unavailable',
        undefined,
        timedOut ? 'WALLET_TIMEOUT' : 'WALLET_UNAVAILABLE',
        timedOut
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const errorBody = asRecord(asRecord(payload)?.error);
      const code = typeof errorBody?.code === 'string' ? errorBody.code : undefined;
      throw new WalletClientError(
        response.status === 401 || response.status === 403
          ? 'Wallet service denied the request'
          : 'Wallet service rejected the request',
        response.status,
        code
      );
    }

    const body = asRecord(payload);
    if (!body || body.success === false || body.data === undefined) {
      throw new WalletClientError('Wallet response is malformed', undefined, 'WALLET_BAD_RESPONSE');
    }
    return body.data;
  }

  /** W1 */
  async run(isFull: boolean, context: WalletRequestContext): Promise<WalletReconciliationReport> {
    const data = await this.request(
      `/api/wallets/admin/reconciliation?isFull=${isFull ? 'true' : 'false'}`,
      context
    );
    return normalizeReport(data);
  }

  /** W2 */
  async listReports(page: number, limit: number, context: WalletRequestContext): Promise<WalletReportPage> {
    const data = asRecord(
      await this.request(
        `/api/wallets/admin/reconciliation/reports?page=${page}&limit=${limit}`,
        context
      )
    );
    if (!data || !Array.isArray(data.items)) {
      throw new WalletClientError('Wallet report list is malformed', undefined, 'WALLET_BAD_RESPONSE');
    }
    return {
      items: data.items.map(normalizeReport),
      page: asPositiveInt(data.page) ?? page,
      limit: asPositiveInt(data.limit) ?? limit,
      total: typeof data.total === 'number' ? data.total : 0,
    };
  }

  /** W3 */
  async getReport(id: number, context: WalletRequestContext): Promise<WalletReconciliationReport> {
    return normalizeReport(
      await this.request(`/api/wallets/admin/reconciliation/reports/${id}`, context)
    );
  }

  /** W4 */
  async adjustAnomaly(
    anomalyId: string,
    body: AdjustAnomalyRequest,
    context: WalletRequestContext
  ): Promise<WalletAdjustResult> {
    const data = asRecord(
      await this.request(
        `/api/wallets/admin/reconciliation/anomalies/${encodeURIComponent(anomalyId)}/adjust`,
        context,
        { method: 'POST', body }
      )
    );
    return {
      transactionId: typeof data?.transactionId === 'string' ? data.transactionId : null,
      replayed: data?.replayed === true,
    };
  }
}

test('K17-E2E: Tích hợp trực tiếp WalletReconciliationClient (Admin) với Wallet Service thật (W1–W4, A8/RC1)', async () => {
  const appModule = await import('../src/app');
  const app = appModule.default;
  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const client = new WalletReconciliationClient(baseUrl);
  const context = {
    gatewayToken: adminToken(),
    requestId: `req-k17-e2e-${randomUUID()}`,
  };

  // 1. Tạo ví và ghi nhận bút toán hợp lệ 100.000đ
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
      referenceId: `seed_admin_client_${randomUUID()}`,
      transferType: 'TOPUP',
    },
  });

  // 2. Baseline: Chạy đối soát W1 qua client -> chưa có drift trên ví này
  const baselineReport = await client.run(true, context);
  assert.ok(baselineReport.id > 0);
  const initialAnomaly = baselineReport.anomalies.find(a => a.walletId === wallet.id);
  assert.equal(initialAnomaly, undefined, 'Ví ban đầu phải hoàn toàn cân bằng');

  // 3. Fixture lệch: Cố ý sửa số dư ví lên 150.000đ (+50.000đ) mà không qua LedgerEntry
  await prisma.wallet.update({
    where: { id: wallet.id },
    data: { balance: 150000 },
  });

  // 4. Quét đối soát W1 qua client -> Phát hiện bất thường BALANCE_DRIFT
  const scanReport = await client.run(true, context);
  assert.equal(scanReport.isBalanced, false);
  const driftAnomaly = scanReport.anomalies.find(a => a.walletId === wallet.id);
  assert.ok(driftAnomaly, 'Client Admin phải nhận được anomaly drift của ví');
  assert.equal(driftAnomaly.type, 'BALANCE_DRIFT');

  // 5. Kiểm tra W2 listReports qua client
  const listResult = await client.listReports(1, 10, context);
  assert.ok(listResult.items.length > 0);
  assert.ok(listResult.total >= 1);
  const foundReportInList = listResult.items.find(r => r.id === scanReport.id);
  assert.ok(foundReportInList, 'Danh sách báo cáo phải chứa báo cáo vừa quét');

  // 6. Kiểm tra W3 getReport qua client
  const reportDetail = await client.getReport(scanReport.id, context);
  assert.equal(reportDetail.id, scanReport.id);
  const detailAnomaly = reportDetail.anomalies.find(a => a.walletId === wallet.id);
  assert.ok(detailAnomaly, 'Chi tiết báo cáo phải chứa anomaly của ví');

  // Lưu snapshot LedgerEntry trước điều chỉnh W4
  const ledgerCountBefore = await prisma.ledgerEntry.count({ where: { walletId: wallet.id } });
  const ledgerBefore = await prisma.ledgerEntry.findMany({ where: { walletId: wallet.id } });

  try {
    // 7. Gọi W4 adjustAnomaly qua client Admin với contract đầy đủ
    const referenceId = `adjust-anomaly-${driftAnomaly.id}`;
    const adjustResult = await client.adjustAnomaly(
      driftAnomaly.id,
      {
        direction: 'DEBIT',
        amount: '50000',
        reason: 'Điều chỉnh lệch số dư qua Admin Client theo biên bản kiểm toán',
        referenceId,
      },
      context
    );

    // Kiểm tra kết quả client nhận được
    assert.equal(adjustResult.replayed, false);
    assert.equal(adjustResult.transactionId, null);

    // Kiểm tra DB ví: số dư đã được đồng bộ chuẩn xác về 100.000đ
    const walletAfter = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    assert.equal(walletAfter.balance.toFixed(2), '100000.00');

    // Kiểm tra DB Anomaly: trạng thái RESOLVED
    const anomalyInDb = await prisma.reconciliationAnomaly.findUniqueOrThrow({
      where: { id: BigInt(driftAnomaly.id) },
    });
    assert.equal(anomalyInDb.status, 'RESOLVED');
    assert.equal(anomalyInDb.adjustmentReferenceId, referenceId);

    // Kiểm tra DB AnomalyAdjustment
    const adjInDb = await prisma.anomalyAdjustment.findUniqueOrThrow({
      where: { anomalyId: BigInt(driftAnomaly.id) },
    });
    assert.equal(adjInDb.walletId, wallet.id);
    assert.equal(adjInDb.delta.toFixed(2), '50000.00');
    assert.equal(adjInDb.referenceId, referenceId);

    // BẢO TOÀN SỔ CÁI: LedgerEntry hoàn toàn bất biến, không bị sửa/xóa/thêm
    const ledgerCountAfter = await prisma.ledgerEntry.count({ where: { walletId: wallet.id } });
    const ledgerAfter = await prisma.ledgerEntry.findMany({ where: { walletId: wallet.id } });
    assert.equal(ledgerCountAfter, ledgerCountBefore);
    assert.equal(ledgerAfter[0].id, ledgerBefore[0].id);
    assert.equal(ledgerAfter[0].amount.toFixed(2), ledgerBefore[0].amount.toFixed(2));

    // 8. Idempotency qua client: Gọi lại điều chỉnh cùng anomaly
    const replayResult = await client.adjustAnomaly(
      driftAnomaly.id,
      {
        direction: 'DEBIT',
        amount: '50000',
        reason: 'Điều chỉnh lệch số dư qua Admin Client (gọi lại)',
        referenceId,
      },
      context
    );
    assert.equal(replayResult.replayed, true);
    assert.equal(replayResult.transactionId, null);

    // Số dư ví vẫn 100.000đ và không có bản ghi AnomalyAdjustment thứ hai
    const walletAfterReplay = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    assert.equal(walletAfterReplay.balance.toFixed(2), '100000.00');
    const adjCount = await prisma.anomalyAdjustment.count({
      where: { anomalyId: BigInt(driftAnomaly.id) },
    });
    assert.equal(adjCount, 1);

    // 9. Quét lại W1 qua client: Không còn bất thường trên ví này
    const finalReport = await client.run(true, context);
    const finalAnomaly = finalReport.anomalies.find(a => a.walletId === wallet.id);
    assert.equal(finalAnomaly, undefined, 'Ví đã sạch hoàn toàn sau khi điều chỉnh');
  } finally {
    await prisma.anomalyAdjustment.deleteMany({ where: { walletId: wallet.id } });
    await prisma.reconciliationAnomaly.deleteMany({ where: { walletId: wallet.id } });
    await prisma.wallet.delete({ where: { id: wallet.id } }).catch(() => {});
    server.close();
  }
});
