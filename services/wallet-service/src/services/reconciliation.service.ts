import { AnomalyType, Prisma, PrismaClient } from '@prisma/client';
import { DomainException } from '../utils/domain.exception';

const prisma = new PrismaClient();

export interface AnomalyView {
  id: string;
  reportId: number;
  type: string;
  mode?: string | null;
  walletId: number | null;
  transactionId: string | null;
  expected: string | null;
  actual: string | null;
  difference: string | null;
  status: string;
  detectedAt: string;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  resolutionNote?: string | null;
  detail: any;
}

export interface ReportView {
  id: number;
  mode: string;
  runAt: string;
  totalWallets: number;
  anomaliesFound: number;
  systemBalanceExpected: string;
  systemBalanceActual: string;
  totalBalance: string;
  isBalanced: boolean;
  anomalies: AnomalyView[];
}

export const formatAnomaly = (anomaly: any): AnomalyView => {
  const isDrift =
    anomaly.type === AnomalyType.BALANCE_DRIFT_QUICK ||
    anomaly.type === AnomalyType.BALANCE_DRIFT_FULL ||
    anomaly.type === 'BALANCE_DRIFT';
  const type = isDrift ? 'BALANCE_DRIFT' : String(anomaly.type);

  let mode: string | null = null;
  if (anomaly.type === AnomalyType.BALANCE_DRIFT_QUICK) mode = 'QUICK';
  else if (anomaly.type === AnomalyType.BALANCE_DRIFT_FULL) mode = 'FULL';
  else if (anomaly.detail && typeof anomaly.detail === 'object' && anomaly.detail.mode) {
    mode = String(anomaly.detail.mode);
  }

  const detail =
    anomaly.detail && typeof anomaly.detail === 'object' && !Array.isArray(anomaly.detail)
      ? { ...anomaly.detail }
      : {};
  if (mode && !detail.mode) {
    detail.mode = mode;
  }

  const toMoney = (val: any): string | null => {
    if (val === null || val === undefined) return null;
    return new Prisma.Decimal(val.toString()).toFixed(2);
  };

  return {
    id: String(anomaly.id ?? ''),
    reportId: Number(anomaly.reportId ?? 0),
    type,
    mode,
    walletId: typeof anomaly.walletId === 'number' ? anomaly.walletId : null,
    transactionId: typeof anomaly.transactionId === 'string' ? anomaly.transactionId : null,
    expected: toMoney(anomaly.expected),
    actual: toMoney(anomaly.actual),
    difference: toMoney(anomaly.difference),
    status: String(anomaly.status ?? 'OPEN'),
    detectedAt:
      anomaly.detectedAt instanceof Date
        ? anomaly.detectedAt.toISOString()
        : String(anomaly.detectedAt ?? new Date().toISOString()),
    resolvedAt: anomaly.resolvedAt instanceof Date ? anomaly.resolvedAt.toISOString() : (anomaly.resolvedAt ?? null),
    resolvedBy: anomaly.resolvedBy ?? null,
    resolutionNote: anomaly.resolutionNote ?? null,
    detail,
  };
};

export const formatReport = (report: any): ReportView => {
  const toMoney = (val: any): string => {
    if (val === null || val === undefined) return '0.00';
    return new Prisma.Decimal(val.toString()).toFixed(2);
  };

  const expectedStr = toMoney(report.systemBalanceExpected);
  const actualStr = toMoney(report.systemBalanceActual);

  return {
    id: Number(report.id),
    mode: String(report.mode ?? 'QUICK'),
    runAt:
      report.runAt instanceof Date
        ? report.runAt.toISOString()
        : String(report.runAt ?? new Date().toISOString()),
    totalWallets: Number(report.totalWallets ?? 0),
    anomaliesFound: Number(report.anomaliesFound ?? 0),
    systemBalanceExpected: expectedStr,
    systemBalanceActual: actualStr,
    totalBalance: actualStr,
    isBalanced: report.isBalanced === true,
    anomalies: Array.isArray(report.anomalies) ? report.anomalies.map(formatAnomaly) : [],
  };
};

export class ReconciliationService {
  async runReconciliation(modeOrIsFull: 'quick' | 'full' | boolean = 'quick'): Promise<ReportView> {
    const isFull =
      typeof modeOrIsFull === 'boolean'
        ? modeOrIsFull
        : String(modeOrIsFull).toLowerCase() === 'full';
    const modeStr = isFull ? 'FULL' : 'QUICK';

    console.log(`[Reconciliation] Starting reconciliation process. mode=${modeStr}`);
    const anomalies: any[] = [];

    // 1. Check Negative Balances
    const negativeBalances = await this.checkNegativeBalances();
    anomalies.push(...negativeBalances);

    // 2. Check Balance Drift
    if (isFull) {
      const fullDrift = await this.checkBalanceDriftFull();
      anomalies.push(...fullDrift);
    } else {
      const quickDrift = await this.checkBalanceDriftQuick();
      anomalies.push(...quickDrift);
    }

    // 3. Check Transaction Integrity
    const unbalancedTxs = await this.checkTransactionIntegrity();
    anomalies.push(...unbalancedTxs);

    // 4. Check System Conservation
    const systemConservation = await this.checkSystemConservation();

    // 5. Calculate Summary & Save Report
    const totalWallets = await prisma.wallet.count();
    const isBalanced = systemConservation.isBalanced && anomalies.length === 0;

    const report = await prisma.reconciliationReport.create({
      data: {
        mode: modeStr,
        totalWallets,
        anomaliesFound: anomalies.length,
        systemBalanceExpected: systemConservation.expected,
        systemBalanceActual: systemConservation.actual,
        isBalanced,
        anomalies: {
          create: anomalies.map(anomaly => ({
            type: anomaly.type,
            walletId: anomaly.walletId ?? null,
            transactionId: anomaly.transactionId ?? null,
            expected: anomaly.expected ?? null,
            actual: anomaly.actual ?? null,
            difference: anomaly.difference ?? null,
            detail: anomaly.detail ?? {},
          })),
        },
      },
      include: {
        anomalies: true,
      },
    });

    console.log(
      `[Reconciliation] Completed. Report ID: ${report.id}. Mode: ${modeStr}. Anomalies found: ${anomalies.length}`
    );
    return formatReport(report);
  }

  async listReports(options: {
    cursor?: string;
    limit?: number;
    page?: number;
    includeAnomalies?: boolean;
  }) {
    const DEFAULT_LIMIT = 20;
    const MAX_LIMIT = 100;

    let limit = options.limit !== undefined ? options.limit : DEFAULT_LIMIT;
    if (isNaN(limit) || !Number.isInteger(limit) || limit <= 0) {
      throw new DomainException(400, 'INVALID_LIMIT', 'Limit must be a positive integer');
    }
    if (limit > MAX_LIMIT) {
      limit = MAX_LIMIT;
    }

    let whereClause: Prisma.ReconciliationReportWhereInput = {};

    if (options.cursor) {
      let decoded: any;
      try {
        const jsonStr = Buffer.from(options.cursor, 'base64url').toString('utf8');
        decoded = JSON.parse(jsonStr);
      } catch {
        throw new DomainException(400, 'INVALID_CURSOR', 'Cursor phân trang không hợp lệ');
      }

      if (!decoded || typeof decoded !== 'object') {
        throw new DomainException(400, 'INVALID_CURSOR', 'Cursor phân trang không hợp lệ');
      }

      const runAtDate = new Date(decoded.runAt);
      const cursorId = Number(decoded.id);

      if (isNaN(runAtDate.getTime()) || !Number.isInteger(cursorId) || cursorId <= 0) {
        throw new DomainException(400, 'INVALID_CURSOR', 'Cursor phân trang không hợp lệ');
      }

      whereClause = {
        OR: [
          { runAt: { lt: runAtDate } },
          { runAt: runAtDate, id: { lt: cursorId } },
        ],
      };
    }

    const total = await prisma.reconciliationReport.count();

    const includeClause = options.includeAnomalies ? { anomalies: true } : undefined;

    let reports: any[];
    if (options.page !== undefined && !options.cursor) {
      const page = options.page;
      if (isNaN(page) || !Number.isInteger(page) || page <= 0) {
        throw new DomainException(400, 'INVALID_PAGE', 'Page must be a positive integer');
      }
      const skip = (page - 1) * limit;
      reports = await prisma.reconciliationReport.findMany({
        orderBy: [{ runAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit + 1,
        include: includeClause,
      });
    } else {
      reports = await prisma.reconciliationReport.findMany({
        where: whereClause,
        orderBy: [{ runAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        include: includeClause,
      });
    }

    const hasMore = reports.length > limit;
    const items = hasMore ? reports.slice(0, limit) : reports;

    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1];
      nextCursor = Buffer.from(
        JSON.stringify({
          runAt: last.runAt.toISOString(),
          id: last.id,
        })
      ).toString('base64url');
    }

    return {
      items: items.map(formatReport),
      nextCursor,
      page: options.page ?? 1,
      limit,
      total,
    };
  }

  private async checkNegativeBalances() {
    const result: any[] = await prisma.$queryRaw`
      SELECT id as "walletId", balance
      FROM "Wallet"
      WHERE balance < 0 AND "ownerType" != 'SYSTEM';
    `;
    return result.map(row => {
      const actual = new Prisma.Decimal(row.balance.toString());
      const expected = new Prisma.Decimal('0.00');
      return {
        type: AnomalyType.NEGATIVE_BALANCE,
        walletId: row.walletId,
        expected,
        actual,
        difference: actual.minus(expected),
        detail: {
          balance: actual.toFixed(2),
        },
      };
    });
  }

  private async checkBalanceDriftQuick() {
    // Quick check compares the latest ledger entry balanceAfter against the current wallet balance
    const result: any[] = await prisma.$queryRaw`
      WITH LatestLedger AS (
        SELECT "walletId", "balanceAfter",
               ROW_NUMBER() OVER(PARTITION BY "walletId" ORDER BY "createdAt" DESC, "id" DESC) as rn
        FROM "LedgerEntry"
      )
      SELECT w.id as "walletId", w.balance as "actualBalance", l."balanceAfter" as "expectedBalance"
      FROM "Wallet" w
      JOIN LatestLedger l ON w.id = l."walletId" AND l.rn = 1
      WHERE ABS(w.balance - l."balanceAfter") > 0.01;
    `;
    return result.map(row => {
      const actual = new Prisma.Decimal(row.actualBalance.toString());
      const expected = new Prisma.Decimal(row.expectedBalance.toString());
      const diff = actual.minus(expected);
      return {
        type: AnomalyType.BALANCE_DRIFT_QUICK,
        walletId: row.walletId,
        expected,
        actual,
        difference: diff,
        detail: {
          mode: 'QUICK',
          expected: expected.toFixed(2),
          actual: actual.toFixed(2),
          diff: diff.toFixed(2),
        },
      };
    });
  }

  private async checkBalanceDriftFull() {
    // Full check sums all DEBIT/CREDIT transactions for each wallet
    const result: any[] = await prisma.$queryRaw`
      WITH CalculatedBalance AS (
        SELECT "walletId",
               SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END) as "calculatedBalance"
        FROM "LedgerEntry"
        GROUP BY "walletId"
      )
      SELECT w.id as "walletId", w.balance as "actualBalance", c."calculatedBalance" as "expectedBalance"
      FROM "Wallet" w
      JOIN CalculatedBalance c ON w.id = c."walletId"
      WHERE ABS(w.balance - COALESCE(c."calculatedBalance", 0)) > 0.01;
    `;
    return result.map(row => {
      const actual = new Prisma.Decimal(row.actualBalance.toString());
      const expected = new Prisma.Decimal(row.expectedBalance.toString());
      const diff = actual.minus(expected);
      return {
        type: AnomalyType.BALANCE_DRIFT_FULL,
        walletId: row.walletId,
        expected,
        actual,
        difference: diff,
        detail: {
          mode: 'FULL',
          expected: expected.toFixed(2),
          actual: actual.toFixed(2),
          diff: diff.toFixed(2),
        },
      };
    });
  }

  private async checkTransactionIntegrity() {
    // Checks if the sum of CREDIT amounts equals the sum of DEBIT amounts for each transactionId
    const result: any[] = await prisma.$queryRaw`
      SELECT "transactionId",
             SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END) as diff
      FROM "LedgerEntry"
      GROUP BY "transactionId"
      HAVING ABS(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END)) > 0.001;
    `;
    return result.map(row => {
      const diff = new Prisma.Decimal(row.diff.toString());
      return {
        type: AnomalyType.TRANSACTION_UNBALANCED,
        transactionId: row.transactionId,
        expected: new Prisma.Decimal('0.00'),
        actual: diff,
        difference: diff,
        detail: {
          diff: diff.toFixed(2),
        },
      };
    });
  }

  public async checkSystemConservation() {
    // Tổng số dư của tất cả các ví (bao gồm cả ví HỆ THỐNG) theo lý tưởng phải bằng 0 nếu hệ thống là một hệ khép kín.
    const result: any[] = await prisma.$queryRaw`
      SELECT COALESCE(SUM(balance), 0) as "totalBalance"
      FROM "Wallet";
    `;
    const actual = new Prisma.Decimal(result[0]?.totalBalance?.toString() || '0.00');
    const expected = new Prisma.Decimal('0.00');

    return {
      expected,
      actual,
      isBalanced: actual.abs().lessThan(0.001),
    };
  }
}
