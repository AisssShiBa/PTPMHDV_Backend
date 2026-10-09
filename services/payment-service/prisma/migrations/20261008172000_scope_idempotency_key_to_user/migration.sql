-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- Step 1: Pre-check for NULL userId
DO $$
DECLARE
  null_userid_count INT;
BEGIN
  SELECT COUNT(*) INTO null_userid_count FROM "Payment" WHERE "userId" IS NULL;
  IF null_userid_count > 0 THEN
    RAISE EXCEPTION 'Migration failed: Found % payments with NULL userId. Please clean data before migrating.', null_userid_count;
  END IF;
END $$;

-- Step 2: Add new columns
ALTER TABLE "Payment" ADD COLUMN "requestHash" VARCHAR(255);
ALTER TABLE "Payment" ADD COLUMN "idempotencyStatus" "IdempotencyStatus" NOT NULL DEFAULT 'PROCESSING';
ALTER TABLE "Payment" ADD COLUMN "idempotencyExpiresAt" TIMESTAMP(3);

-- Step 3: Backfill data for existing legacy records
-- Backfilling requestHash with a 'LEGACY' placeholder and status as COMPLETED
UPDATE "Payment" 
SET "requestHash" = 'LEGACY', 
    "idempotencyStatus" = 'COMPLETED',
    "idempotencyExpiresAt" = NOW() + INTERVAL '24 hours'
WHERE "requestHash" IS NULL;

-- Step 4: Enforce NOT NULL constraints on new columns after backfilling
ALTER TABLE "Payment" ALTER COLUMN "requestHash" SET NOT NULL;
ALTER TABLE "Payment" ALTER COLUMN "idempotencyExpiresAt" SET NOT NULL;

-- Step 5: Safely drop the old globally unique index
DROP INDEX IF EXISTS "Payment_idempotencyKey_key";

-- Step 6: Create the new unique index scoped to userId (New constraint is looser, so old data won't violate this)
CREATE UNIQUE INDEX "Payment_userId_idempotencyKey_key" ON "Payment"("userId", "idempotencyKey");

-- Step 7: Create cleanup index
CREATE INDEX "Payment_idempotencyExpiresAt_idx" ON "Payment"("idempotencyExpiresAt");
