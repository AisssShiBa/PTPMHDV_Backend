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

export interface AdjustAnomalyInput {
  reason?: string;
  direction?: 'CREDIT' | 'DEBIT' | string;
  amount?: string;
  referenceId?: string;
}

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

  async getReportById(id: number): Promise<ReportView> {
    if (isNaN(id) || !Number.isInteger(id) || id <= 0) {
      throw new DomainException(400, 'INVALID_REPORT_ID', 'Report id must be a positive integer');
    }

    const report = await prisma.reconciliationReport.findUnique({
      where: { id },
      include: {
        anomalies: true,
      },
    });

    if (!report) {
      throw new DomainException(404, 'REPORT_NOT_FOUND', 'Reconciliation report not found');
    }

    return formatReport(report);
  }

  async adjustAnomaly(
    anomalyIdStr: string,
    bodyOrReason: string | AdjustAnomalyInput,
    adminId: string
  ) {
    const input: AdjustAnomalyInput =
      typeof bodyOrReason === 'string' ? { reason: bodyOrReason } : bodyOrReason || {};

    const rawReason = input.reason;
    if (rawReason === undefined || rawReason === null || typeof rawReason !== 'string') {
      console.error(
        JSON.stringify({
          event: 'ANOMALY_ADJUST_ERROR',
          anomalyId: anomalyIdStr,
          adminId,
          code: 'REASON_REQUIRED',
          message: 'reason is required and must contain 5 to 500 characters',
        })
      );
      throw new DomainException(
        400,
        'REASON_REQUIRED',
        'reason is required and must contain 5 to 500 characters'
      );
    }

    const trimmedReason = rawReason.trim();
    if (trimmedReason.length === 0) {
      console.error(
        JSON.stringify({
          event: 'ANOMALY_ADJUST_ERROR',
          anomalyId: anomalyIdStr,
          adminId,
          code: 'REASON_REQUIRED',
          message: 'reason is required and must contain 5 to 500 characters',
        })
      );
      throw new DomainException(
        400,
        'REASON_REQUIRED',
        'reason is required and must contain 5 to 500 characters'
      );
    }

    if (trimmedReason.length < 5) {
      console.error(
        JSON.stringify({
          event: 'ANOMALY_ADJUST_ERROR',
          anomalyId: anomalyIdStr,
          adminId,
          code: 'REASON_REQUIRED',
          message: 'reason must contain 5 to 500 characters',
        })
      );
      throw new DomainException(
        400,
        'REASON_REQUIRED',
        'reason must contain 5 to 500 characters'
      );
    }

    if (trimmedReason.length > 500) {
      console.error(
        JSON.stringify({
          event: 'ANOMALY_ADJUST_ERROR',
          anomalyId: anomalyIdStr,
          adminId,
          code: 'INVALID_REASON',
          message: 'reason must contain 5 to 500 characters',
        })
      );
      throw new DomainException(
        400,
        'INVALID_REASON',
        'reason must contain 5 to 500 characters'
      );
    }

    const rawDirection = input.direction;
    if (rawDirection !== undefined && rawDirection !== null) {
      if (rawDirection !== 'CREDIT' && rawDirection !== 'DEBIT') {
        throw new DomainException(400, 'INVALID_DIRECTION', "direction must be 'CREDIT' or 'DEBIT'");
      }
    }

    const rawAmount = input.amount;
    if (rawAmount !== undefined && rawAmount !== null) {
      if (typeof rawAmount !== 'string' || !/^[1-9]\d*(\.\d{1,2})?$/.test(rawAmount.trim())) {
        throw new DomainException(400, 'INVALID_AMOUNT', 'amount must be a positive integer or decimal string');
      }
      const intDigits = rawAmount.trim().split('.')[0];
      if (intDigits.length > 18 || BigInt(intDigits) > 999_999_999_999_999_999n) {
        throw new DomainException(400, 'INVALID_AMOUNT', 'amount is out of range');
      }
    }

    const rawReferenceId = input.referenceId;
    let effectiveReferenceId = `adjust-anomaly-${anomalyIdStr}`;
    if (rawReferenceId !== undefined && rawReferenceId !== null) {
      if (typeof rawReferenceId !== 'string' || rawReferenceId.trim().length === 0) {
        throw new DomainException(400, 'INVALID_REFERENCE_ID', 'referenceId must be a non-empty string');
      }
      if (rawReferenceId.trim().length > 255) {
        throw new DomainException(400, 'INVALID_REFERENCE_ID', 'referenceId must not exceed 255 characters');
      }
      effectiveReferenceId = rawReferenceId.trim();
    }

    let bigIntId: bigint;
    try {
      bigIntId = BigInt(anomalyIdStr);
      if (bigIntId <= 0n) throw new Error();
    } catch {
      throw new DomainException(400, 'INVALID_ANOMALY_ID', 'Anomaly id must be a positive integer');
    }
    const canonicalReferenceId = `adjust-anomaly-${bigIntId.toString()}`;
    if (rawReferenceId === undefined || rawReferenceId === null) {
      effectiveReferenceId = canonicalReferenceId;
    }

    console.log(
      JSON.stringify({
        event: 'ANOMALY_ADJUST_START',
        anomalyId: anomalyIdStr,
        adminId,
        reason: trimmedReason.substring(0, 100),
        referenceId: effectiveReferenceId,
      })
    );

    try {
      const result = await prisma.$transaction(
        async tx => {
          // 1. Khóa hàng anomaly bằng SELECT ... FOR UPDATE
          const anomalies = await tx.$queryRaw<any[]>`
            SELECT id, "reportId", type, "walletId", expected, actual, difference, status, "resolutionNote", "adjustmentReferenceId"
            FROM "ReconciliationAnomaly"
            WHERE id = ${bigIntId}
            FOR UPDATE
          `;

          if (!anomalies || anomalies.length === 0) {
            throw new DomainException(404, 'ANOMALY_NOT_FOUND', 'Reconciliation anomaly not found');
          }

          const anomaly = anomalies[0];

          // 2. Nếu anomaly đã được giải quyết -> Idempotent replay
          if (anomaly.status === 'RESOLVED') {
            const existingAdj = await tx.anomalyAdjustment.findUnique({
              where: { anomalyId: bigIntId },
            });
            if (rawReferenceId && existingAdj && existingAdj.referenceId !== rawReferenceId.trim()) {
              throw new DomainException(
                409,
                'ALREADY_ADJUSTED',
                'This anomaly has already been adjusted with a different referenceId'
              );
            }
            return {
              anomalyId: anomaly.id.toString(),
              status: 'RESOLVED',
              walletId: anomaly.walletId,
              delta: existingAdj ? existingAdj.delta.toFixed(2) : (anomaly.difference?.toString() ?? '0.00'),
              expectedBalance: anomaly.expected?.toString() ?? '0.00',
              actualBalance: anomaly.expected?.toString() ?? '0.00',
              replayed: true,
              transactionId: null,
              referenceId: existingAdj?.referenceId ?? anomaly.adjustmentReferenceId ?? effectiveReferenceId,
              adjustment: existingAdj
                ? {
                    id: existingAdj.id.toString(),
                    anomalyId: existingAdj.anomalyId.toString(),
                    walletId: existingAdj.walletId,
                    delta: existingAdj.delta.toFixed(2),
                    reason: existingAdj.reason,
                    adminId: existingAdj.adminId,
                    referenceId: existingAdj.referenceId,
                    createdAt: existingAdj.createdAt.toISOString(),
                  }
                : null,
            };
          }

          // 3. Kiểm tra loại anomaly có được hỗ trợ điều chỉnh tự động không
          const isDrift =
            anomaly.type === AnomalyType.BALANCE_DRIFT_QUICK ||
            anomaly.type === AnomalyType.BALANCE_DRIFT_FULL ||
            anomaly.type === 'BALANCE_DRIFT';

          if (!isDrift || !anomaly.walletId) {
            throw new DomainException(
              422,
              'ADJUST_NOT_SUPPORTED',
              `Anomaly type ${anomaly.type} cannot be adjusted automatically`
            );
          }
          if (effectiveReferenceId !== canonicalReferenceId) {
            throw new DomainException(400, 'INVALID_REFERENCE_ID', 'referenceId must be adjust-anomaly-<id>');
          }

          // 4. Khóa hàng ví theo thứ tự ID tăng dần để triệt tiêu nguy cơ Deadlock
          const wallets = await tx.$queryRaw<any[]>`
            SELECT id, balance, "heldBalance", "ownerType"
            FROM "Wallet"
            WHERE id = ${anomaly.walletId}
            FOR UPDATE
          `;

          if (!wallets || wallets.length === 0) {
            throw new DomainException(404, 'WALLET_NOT_FOUND', 'Wallet not found');
          }

          const wallet = wallets[0];

          // 5. Tính số dư kỳ vọng từ Sổ cái LedgerEntry (nguồn sự thật duy nhất)
          const ledgerSumResult = await tx.$queryRaw<any[]>`
            SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0) as "expectedBalance"
            FROM "LedgerEntry"
            WHERE "walletId" = ${wallet.id}
          `;

          const expectedBalance = new Prisma.Decimal(
            ledgerSumResult[0]?.expectedBalance?.toString() || '0.00'
          );
          const currentBalance = new Prisma.Decimal(wallet.balance.toString());
          const heldBalance = new Prisma.Decimal(wallet.heldBalance.toString());
          // Repairing a cache cannot invalidate reservations or conceal a bad
          // ledger. Keep the anomaly OPEN; no hold or ledger row is rewritten.
          if (heldBalance.lessThan(0) ||
              (wallet.ownerType !== 'SYSTEM' && expectedBalance.lessThan(heldBalance))) {
            throw new DomainException(
              409,
              'REPAIR_CONFLICTS_WITH_HOLDS',
              'Ledger balance cannot cover existing holds; investigate before repairing the cache'
            );
          }
          const delta = currentBalance.minus(expectedBalance);

          // Kiểm tra tính tương thích ngữ nghĩa của direction và amount nếu được truyền vào
          const requiredDirection = delta.greaterThan(0) ? 'DEBIT' : 'CREDIT';
          const requiredAmount = delta.abs();

          if (rawDirection) {
            if (rawDirection !== requiredDirection) {
              throw new DomainException(
                400,
                'DIRECTION_MISMATCH',
                `Adjustment direction '${rawDirection}' does not match required direction '${requiredDirection}' to resolve balance drift`
              );
            }
          }

          if (rawAmount) {
            const parsedAmount = new Prisma.Decimal(rawAmount.trim());
            if (!parsedAmount.equals(requiredAmount)) {
              throw new DomainException(
                400,
                'AMOUNT_MISMATCH',
                `Adjustment amount '${rawAmount.trim()}' does not match required drift amount '${requiredAmount.toFixed(2)}'`
              );
            }
          }

          // 6. Đồng bộ Wallet.balance về số dư sổ cái (TUYỆT ĐỐI không sửa/xóa LedgerEntry)
          await tx.wallet.update({
            where: { id: wallet.id },
            data: {
              balance: expectedBalance,
            },
          });

          // 7. Cập nhật Anomaly sang trạng thái RESOLVED
          const now = new Date();

          await tx.reconciliationAnomaly.update({
            where: { id: bigIntId },
            data: {
              status: 'RESOLVED',
              resolvedAt: now,
              resolvedBy: adminId,
              resolutionNote: trimmedReason,
              adjustmentReferenceId: effectiveReferenceId,
            },
          });

          // 8. Ghi bản ghi AnomalyAdjustment độc lập
          const adjustment = await tx.anomalyAdjustment.create({
            data: {
              anomalyId: bigIntId,
              walletId: wallet.id,
              delta,
              reason: trimmedReason,
              adminId,
              referenceId: effectiveReferenceId,
              createdAt: now,
            },
          });

          return {
            anomalyId: anomaly.id.toString(),
            status: 'RESOLVED',
            walletId: wallet.id,
            delta: delta.toFixed(2),
            expectedBalance: expectedBalance.toFixed(2),
            actualBalance: expectedBalance.toFixed(2),
            replayed: false,
            transactionId: null,
            referenceId: effectiveReferenceId,
            adjustment: {
              id: adjustment.id.toString(),
              anomalyId: adjustment.anomalyId.toString(),
              walletId: adjustment.walletId,
              delta: adjustment.delta.toFixed(2),
              reason: adjustment.reason,
              adminId: adjustment.adminId,
              referenceId: adjustment.referenceId,
              createdAt: adjustment.createdAt.toISOString(),
            },
          };
        },
        { timeout: 15000, maxWait: 10000 }
      );

      console.log(
        JSON.stringify({
          event: 'ANOMALY_ADJUST_SUCCESS',
          anomalyId: anomalyIdStr,
          walletId: result.walletId,
          delta: result.delta,
          replayed: result.replayed,
          referenceId: result.referenceId,
          adminId,
        })
      );

      return result;
    } catch (err: any) {
      if (err instanceof DomainException) {
        console.error(
          JSON.stringify({
            event: 'ANOMALY_ADJUST_ERROR',
            anomalyId: anomalyIdStr,
            adminId,
            code: err.code,
            message: err.message,
          })
        );
      } else {
        console.error(
          JSON.stringify({
            event: 'ANOMALY_ADJUST_ERROR',
            anomalyId: anomalyIdStr,
            adminId,
            code: 'INTERNAL_ERROR',
            message: err.message,
          })
        );
      }
      throw err;
    }
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
      SELECT w.id as "walletId", w.balance as "actualBalance", COALESCE(l."balanceAfter", 0) as "expectedBalance"
      FROM "Wallet" w
      LEFT JOIN LatestLedger l ON w.id = l."walletId" AND l.rn = 1
      WHERE ABS(w.balance - COALESCE(l."balanceAfter", 0)) > 0.01;
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
      SELECT w.id as "walletId", w.balance as "actualBalance", COALESCE(c."calculatedBalance", 0) as "expectedBalance"
      FROM "Wallet" w
      LEFT JOIN CalculatedBalance c ON w.id = c."walletId"
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
