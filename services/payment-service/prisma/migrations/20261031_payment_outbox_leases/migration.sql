ALTER TYPE "OutboxEventStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';

ALTER TABLE "OutboxEvent"
  ADD COLUMN IF NOT EXISTS "lockedUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lockToken" UUID;

CREATE INDEX IF NOT EXISTS "OutboxEvent_status_nextRetryAt_lockedUntil_idx"
  ON "OutboxEvent" ("status", "nextRetryAt", "lockedUntil");
