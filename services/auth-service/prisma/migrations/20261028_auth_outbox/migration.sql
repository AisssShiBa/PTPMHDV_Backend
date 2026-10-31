CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');
CREATE TABLE "AuthOutboxEvent" (
  "id" TEXT PRIMARY KEY, "aggregateId" TEXT NOT NULL, "eventType" TEXT NOT NULL, "payload" JSONB NOT NULL,
  "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMP(3), "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "lockedUntil" TIMESTAMP(3), "lockToken" TEXT
);
CREATE INDEX "AuthOutboxEvent_status_createdAt_idx" ON "AuthOutboxEvent"("status", "createdAt");
