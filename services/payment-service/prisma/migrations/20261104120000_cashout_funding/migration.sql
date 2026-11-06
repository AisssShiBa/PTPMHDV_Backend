-- H12 cash-out. Branch-side only: do not merge before Khoa's K13 Payment enum
-- migration lands (STOP-2). No existing table is altered, so this migration is
-- additive and safe to apply onto a database that already holds P2P data.

DO $$ BEGIN
  CREATE TYPE "CashOutStatus" AS ENUM ('REQUESTED', 'HOLDING', 'PAYOUT_PENDING', 'SUCCEEDED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "CashOut" (
    "id" UUID NOT NULL,
    "userId" VARCHAR(50) NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "destination" VARCHAR(255),
    "idempotencyKey" VARCHAR(255) NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "status" "CashOutStatus" NOT NULL DEFAULT 'REQUESTED',
    "workflow" VARCHAR(20) NOT NULL DEFAULT 'IDLE',
    "tokenJti" VARCHAR(100),
    "holdRef" VARCHAR(255) NOT NULL,
    "providerRef" VARCHAR(255),
    "walletTransactionId" UUID,
    "failureReason" TEXT,
    "nextRetryAt" TIMESTAMP(3),
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" UUID,
    "leaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashOut_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CashOut_tokenJti_key" ON "CashOut"("tokenJti");
CREATE UNIQUE INDEX IF NOT EXISTS "CashOut_holdRef_key" ON "CashOut"("holdRef");
CREATE UNIQUE INDEX IF NOT EXISTS "CashOut_providerRef_key" ON "CashOut"("providerRef");
CREATE UNIQUE INDEX IF NOT EXISTS "CashOut_userId_idempotencyKey_key" ON "CashOut"("userId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "CashOut_status_nextRetryAt_idx" ON "CashOut"("status", "nextRetryAt");
CREATE INDEX IF NOT EXISTS "CashOut_userId_createdAt_idx" ON "CashOut"("userId", "createdAt");

CREATE TABLE IF NOT EXISTS "CashOutStatusLog" (
    "id" UUID NOT NULL,
    "cashOutId" UUID NOT NULL,
    "fromStatus" "CashOutStatus",
    "toStatus" "CashOutStatus" NOT NULL,
    "note" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashOutStatusLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CashOutStatusLog_cashOutId_idx" ON "CashOutStatusLog"("cashOutId");

ALTER TABLE "CashOutStatusLog" DROP CONSTRAINT IF EXISTS "CashOutStatusLog_cashOutId_fkey";
ALTER TABLE "CashOutStatusLog" ADD CONSTRAINT "CashOutStatusLog_cashOutId_fkey"
  FOREIGN KEY ("cashOutId") REFERENCES "CashOut"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$ BEGIN
  CREATE TYPE "MockPayoutResult" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Durable stand-in for the Payout Bank. Keyed by providerRef so a retried
-- payout can never move money twice and an HTTP timeout can be resolved by query.
CREATE TABLE IF NOT EXISTS "MockPayout" (
    "providerRef" VARCHAR(255) NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "result" "MockPayoutResult" NOT NULL DEFAULT 'PENDING',
    "timeoutResponse" BOOLEAN NOT NULL DEFAULT false,
    "bankTransactionId" VARCHAR(100),
    "failureCode" VARCHAR(50),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MockPayout_pkey" PRIMARY KEY ("providerRef")
);

CREATE INDEX IF NOT EXISTS "MockPayout_result_idx" ON "MockPayout"("result");
