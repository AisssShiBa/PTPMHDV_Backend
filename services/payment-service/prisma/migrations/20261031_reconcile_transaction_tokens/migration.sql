-- Reconcile Huu's UUID token table with main's token ownership metadata.
-- Preserve previously consumed tokens so merging cannot re-enable token replay.
ALTER TABLE "UsedTransactionToken"
  ALTER COLUMN "jti" TYPE VARCHAR(100) USING "jti"::text,
  ALTER COLUMN "usedAt" TYPE TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "userId" VARCHAR(50);

UPDATE "UsedTransactionToken" AS token
SET "userId" = payment."userId"
FROM "Payment" AS payment
WHERE token."paymentId" = payment."id" AND token."userId" IS NULL;

ALTER TABLE "UsedTransactionToken" ALTER COLUMN "userId" SET NOT NULL;
