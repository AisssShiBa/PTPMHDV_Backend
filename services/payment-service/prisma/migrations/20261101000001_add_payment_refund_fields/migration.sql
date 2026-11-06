-- AlterTable
ALTER TABLE "Payment"
  ADD COLUMN IF NOT EXISTS "failureCode" VARCHAR(50),
  ADD COLUMN IF NOT EXISTS "refundAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "nextRefundAttemptAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "refundRequestedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "refundedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "needsAttention" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Payment_status_nextRefundAttemptAt_idx"
  ON "Payment"("status", "nextRefundAttemptAt");
