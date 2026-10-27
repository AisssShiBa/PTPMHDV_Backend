-- 1. Alter Table Wallet: add kycTier
ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "kycTier" INTEGER NOT NULL DEFAULT 0;

-- 2. Alter Table WalletHold: add usageDay
ALTER TABLE "WalletHold" ADD COLUMN IF NOT EXISTS "usageDay" VARCHAR(10);

-- 3. Create Table LimitPolicy
CREATE TABLE IF NOT EXISTS "LimitPolicy" (
    "kycTier" INTEGER NOT NULL,
    "perTxn" DECIMAL(20,2) NOT NULL,
    "perDay" DECIMAL(20,2) NOT NULL,
    "perMonth" DECIMAL(20,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LimitPolicy_pkey" PRIMARY KEY ("kycTier")
);

-- 4. Create Table UserDailyUsage
CREATE TABLE IF NOT EXISTS "UserDailyUsage" (
    "id" BIGSERIAL NOT NULL,
    "userId" VARCHAR(50) NOT NULL,
    "day" VARCHAR(10) NOT NULL,
    "monthKey" VARCHAR(7) NOT NULL,
    "spentDay" DECIMAL(20,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserDailyUsage_pkey" PRIMARY KEY ("id")
);

-- 5. Create unique and index on UserDailyUsage
CREATE UNIQUE INDEX IF NOT EXISTS "UserDailyUsage_userId_day_key" ON "UserDailyUsage"("userId", "day");
CREATE INDEX IF NOT EXISTS "UserDailyUsage_userId_monthKey_idx" ON "UserDailyUsage"("userId", "monthKey");

-- 6. Seed LimitPolicy for 3 tiers
INSERT INTO "LimitPolicy" ("kycTier", "perTxn", "perDay", "perMonth", "createdAt", "updatedAt")
VALUES
  (0, 200000.00, 500000.00, 2000000.00, NOW(), NOW()),
  (1, 10000000.00, 20000000.00, 100000000.00, NOW(), NOW()),
  (2, 50000000.00, 100000000.00, 500000000.00, NOW(), NOW())
ON CONFLICT ("kycTier") DO UPDATE SET
  "perTxn" = EXCLUDED."perTxn",
  "perDay" = EXCLUDED."perDay",
  "perMonth" = EXCLUDED."perMonth",
  "updatedAt" = NOW();
