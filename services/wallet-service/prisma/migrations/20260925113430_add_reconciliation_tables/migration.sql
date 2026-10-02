-- CreateEnum
CREATE TYPE "AnomalyType" AS ENUM ('NEGATIVE_BALANCE', 'BALANCE_DRIFT_QUICK', 'BALANCE_DRIFT_FULL', 'TRANSACTION_UNBALANCED');

-- CreateTable
CREATE TABLE "ReconciliationReport" (
    "id" SERIAL NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalWallets" INTEGER NOT NULL,
    "anomaliesFound" INTEGER NOT NULL,
    "systemBalanceExpected" DECIMAL(20,2) NOT NULL,
    "systemBalanceActual" DECIMAL(20,2) NOT NULL,
    "isBalanced" BOOLEAN NOT NULL,

    CONSTRAINT "ReconciliationReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationAnomaly" (
    "id" BIGSERIAL NOT NULL,
    "reportId" INTEGER NOT NULL,
    "type" "AnomalyType" NOT NULL,
    "walletId" INTEGER,
    "transactionId" UUID,
    "detail" JSONB NOT NULL,

    CONSTRAINT "ReconciliationAnomaly_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReconciliationReport_runAt_idx" ON "ReconciliationReport"("runAt");

-- CreateIndex
CREATE INDEX "ReconciliationAnomaly_reportId_idx" ON "ReconciliationAnomaly"("reportId");

-- CreateIndex
CREATE INDEX "ReconciliationAnomaly_type_idx" ON "ReconciliationAnomaly"("type");

-- CreateIndex
CREATE INDEX "ReconciliationAnomaly_walletId_idx" ON "ReconciliationAnomaly"("walletId");

-- AddForeignKey
ALTER TABLE "ReconciliationAnomaly" ADD CONSTRAINT "ReconciliationAnomaly_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "ReconciliationReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
