import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AnomalyType } from '@prisma/client';
import { randomUUID } from 'crypto';

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async runReconciliation(isFull: boolean = false) {
    this.logger.log(`Starting reconciliation process. isFull=${isFull}`);
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
    const totalWallets = await this.prisma.wallet.count();
    
    const report = await this.prisma.reconciliationReport.create({
      data: {
        totalWallets,
        anomaliesFound: anomalies.length,
        systemBalanceExpected: systemConservation.expected,
        systemBalanceActual: systemConservation.actual,
        isBalanced: systemConservation.isBalanced,
        anomalies: {
          create: anomalies.map(anomaly => ({
            type: anomaly.type,
            walletId: anomaly.walletId,
            transactionId: anomaly.transactionId,
            detail: anomaly.detail,
          })),
        },
      },
    });

    this.logger.log(`Reconciliation completed. Report ID: ${report.id}. Anomalies found: ${anomalies.length}`);
    return report;
  }

  private async checkNegativeBalances() {
    const result: any[] = await this.prisma.$queryRaw`
      SELECT id as "walletId", balance
      FROM "Wallet"
      WHERE balance < 0;
    `;
    return result.map(row => ({
      type: AnomalyType.NEGATIVE_BALANCE,
      walletId: row.walletId,
      detail: { balance: row.balance },
    }));
  }

  private async checkBalanceDriftQuick() {
    // Quick check compares the latest ledger entry balanceAfter against the current wallet balance
    const result: any[] = await this.prisma.$queryRaw`
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
    return result.map(row => ({
      type: AnomalyType.BALANCE_DRIFT_QUICK,
      walletId: row.walletId,
      detail: { 
        expected: row.expectedBalance, 
        actual: row.actualBalance, 
        diff: row.actualBalance - row.expectedBalance 
      },
    }));
  }

  private async checkBalanceDriftFull() {
    // Full check sums all DEBIT/CREDIT transactions for each wallet
    const result: any[] = await this.prisma.$queryRaw`
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
    return result.map(row => ({
      type: AnomalyType.BALANCE_DRIFT_FULL,
      walletId: row.walletId,
      detail: { 
        expected: row.expectedBalance, 
        actual: row.actualBalance 
      },
    }));
  }

  private async checkTransactionIntegrity() {
    // Checks if the sum of CREDIT amounts equals the sum of DEBIT amounts for each transactionId
    const result: any[] = await this.prisma.$queryRaw`
      SELECT "transactionId",
             SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END) as diff
      FROM "LedgerEntry"
      GROUP BY "transactionId"
      HAVING ABS(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END)) > 0.01;
    `;
    return result.map(row => ({
      type: AnomalyType.TRANSACTION_UNBALANCED,
      transactionId: row.transactionId,
      detail: { diff: row.diff },
    }));
  }

  private async checkSystemConservation() {
    // Sum of all balances (including SYSTEM) should ideally be 0 if the system is closed
    const result: any[] = await this.prisma.$queryRaw`
      SELECT SUM(balance) as "totalBalance"
      FROM "Wallet";
    `;
    const actual = result[0]?.totalBalance || 0;
    const expected = 0; // Or whatever initial constant was injected into the system

    return {
      expected,
      actual,
      isBalanced: Math.abs(actual - expected) < 0.01,
    };
  }
}
