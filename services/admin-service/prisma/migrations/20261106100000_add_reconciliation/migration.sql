-- CreateEnum
CREATE TYPE "ReconciliationMode" AS ENUM ('QUICK', 'FULL');

-- CreateEnum
CREATE TYPE "ReconciliationRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AnomalyAdjustmentDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "AnomalyAdjustmentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "reconciliation_run_logs" (
    "id" TEXT NOT NULL,
    "wallet_report_id" TEXT,
    "mode" "ReconciliationMode" NOT NULL,
    "admin_id" TEXT NOT NULL,
    "status" "ReconciliationRunStatus" NOT NULL DEFAULT 'RUNNING',
    "is_balanced" BOOLEAN,
    "anomalies_found" INTEGER,
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "request_id" TEXT,

    CONSTRAINT "reconciliation_run_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anomaly_adjustments" (
    "id" TEXT NOT NULL,
    "anomaly_id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "direction" "AnomalyAdjustmentDirection" NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "AnomalyAdjustmentStatus" NOT NULL DEFAULT 'PENDING',
    "reference_id" TEXT NOT NULL,
    "wallet_transaction_id" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "anomaly_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reconciliation_run_logs_mode_status_run_at_idx" ON "reconciliation_run_logs"("mode", "status", "run_at");

-- CreateIndex
CREATE INDEX "reconciliation_run_logs_run_at_idx" ON "reconciliation_run_logs"("run_at");

-- At most one RUNNING reconciliation per mode. Stale rows are aged out by the
-- service after 60 seconds, which keeps a crashed run from blocking forever
-- while making the in-progress check race-free.
CREATE UNIQUE INDEX "reconciliation_run_logs_running_mode_key" ON "reconciliation_run_logs"("mode") WHERE "status" = 'RUNNING';

-- CreateIndex
CREATE UNIQUE INDEX "anomaly_adjustments_anomaly_id_key" ON "anomaly_adjustments"("anomaly_id");

-- CreateIndex
CREATE UNIQUE INDEX "anomaly_adjustments_reference_id_key" ON "anomaly_adjustments"("reference_id");

-- CreateIndex
CREATE INDEX "anomaly_adjustments_status_idx" ON "anomaly_adjustments"("status");
