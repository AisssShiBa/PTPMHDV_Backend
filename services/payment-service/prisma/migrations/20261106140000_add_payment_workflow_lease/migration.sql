-- AlterTable
ALTER TABLE "Payment"
  ADD COLUMN IF NOT EXISTS "workerLeaseUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "attempt" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Payment_workflow_workerLeaseUntil_idx"
  ON "Payment"("workflow", "workerLeaseUntil");
