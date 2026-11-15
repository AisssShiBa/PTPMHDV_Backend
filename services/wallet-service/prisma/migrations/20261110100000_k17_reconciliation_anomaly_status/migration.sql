-- CreateEnum
CREATE TYPE "AnomalyStatus" AS ENUM ('OPEN', 'RESOLVED');

-- AlterTable ReconciliationReport
ALTER TABLE "ReconciliationReport" ADD COLUMN "mode" VARCHAR(10) NOT NULL DEFAULT 'QUICK';
CREATE INDEX IF NOT EXISTS "ReconciliationReport_runAt_id_idx" ON "ReconciliationReport"("runAt" DESC, "id" DESC);

-- AlterTable ReconciliationAnomaly
ALTER TABLE "ReconciliationAnomaly" 
  ADD COLUMN "status" "AnomalyStatus" NOT NULL DEFAULT 'OPEN',
  ADD COLUMN "expected" DECIMAL(20, 2),
  ADD COLUMN "actual" DECIMAL(20, 2),
  ADD COLUMN "difference" DECIMAL(20, 2),
  ADD COLUMN "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "resolvedAt" TIMESTAMP(3),
  ADD COLUMN "resolvedBy" VARCHAR(50),
  ADD COLUMN "resolutionNote" TEXT,
  ADD COLUMN "adjustmentReferenceId" VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS "ReconciliationAnomaly_adjustmentReferenceId_key" ON "ReconciliationAnomaly"("adjustmentReferenceId");
CREATE INDEX IF NOT EXISTS "ReconciliationAnomaly_status_idx" ON "ReconciliationAnomaly"("status");

-- CreateTable AnomalyAdjustment
CREATE TABLE IF NOT EXISTS "AnomalyAdjustment" (
  "id" BIGSERIAL PRIMARY KEY,
  "anomalyId" BIGINT NOT NULL,
  "walletId" INTEGER NOT NULL,
  "delta" DECIMAL(20, 2) NOT NULL,
  "reason" TEXT NOT NULL,
  "adminId" VARCHAR(50) NOT NULL,
  "referenceId" VARCHAR(255) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnomalyAdjustment_anomalyId_key" UNIQUE ("anomalyId"),
  CONSTRAINT "AnomalyAdjustment_referenceId_key" UNIQUE ("referenceId"),
  CONSTRAINT "AnomalyAdjustment_anomalyId_fkey" FOREIGN KEY ("anomalyId") REFERENCES "ReconciliationAnomaly"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
