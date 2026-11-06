-- AlterEnum
ALTER TYPE "HoldStatus" ADD VALUE IF NOT EXISTS 'REFUNDED';

-- AlterTable
ALTER TABLE "WalletHold"
  ADD COLUMN IF NOT EXISTS "refundReferenceId" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "refundTransactionId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WalletHold_refundReferenceId_key"
  ON "WalletHold"("refundReferenceId");
