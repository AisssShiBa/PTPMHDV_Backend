-- Wallet-service used to contain copied auth-service tables.  It now owns only
-- wallet accounting data; identity is verified through user-service instead.
ALTER TABLE "Wallet" DROP CONSTRAINT IF EXISTS "Wallet_userId_fkey";

DROP TABLE IF EXISTS "WalletIdempotency";
DROP TABLE IF EXISTS "WalletTransaction";
DROP TABLE IF EXISTS "Session";
DROP TABLE IF EXISTS "User";

CREATE TYPE "OwnerType" AS ENUM ('USER', 'MERCHANT', 'SYSTEM');
CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'LOCKED');
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');
CREATE TYPE "TransferType" AS ENUM ('TOPUP', 'PAYMENT', 'REFUND', 'P2P_TRANSFER', 'ADJUSTMENT');
CREATE TYPE "HoldStatus" AS ENUM ('PENDING', 'CAPTURED', 'RELEASED', 'EXPIRED');

ALTER TABLE "Wallet"
  ALTER COLUMN "userId" DROP NOT NULL,
  ADD COLUMN "ownerType" "OwnerType" NOT NULL DEFAULT 'USER',
  ADD COLUMN "heldBalance" DECIMAL(20,2) NOT NULL DEFAULT 0,
  ADD COLUMN "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE';

ALTER TABLE "Wallet"
  ADD CONSTRAINT "Wallet_balance_nonnegative" CHECK ("balance" >= 0),
  ADD CONSTRAINT "Wallet_heldBalance_nonnegative" CHECK ("heldBalance" >= 0),
  ADD CONSTRAINT "Wallet_heldBalance_lte_balance" CHECK ("heldBalance" <= "balance"),
  ADD CONSTRAINT "Wallet_owner_matches_userId" CHECK (
    ("ownerType" = 'SYSTEM' AND "userId" IS NULL)
    OR ("ownerType" <> 'SYSTEM' AND "userId" IS NOT NULL)
  );

CREATE UNIQUE INDEX "Wallet_single_system_wallet"
  ON "Wallet" ("ownerType") WHERE "ownerType" = 'SYSTEM';
CREATE INDEX "Wallet_ownerType_status_idx" ON "Wallet" ("ownerType", "status");

CREATE TABLE "LedgerEntry" (
  "id" BIGSERIAL NOT NULL,
  "transactionId" UUID NOT NULL,
  "walletId" INTEGER NOT NULL,
  "direction" "LedgerDirection" NOT NULL,
  "amount" DECIMAL(20,2) NOT NULL,
  "balanceAfter" DECIMAL(20,2) NOT NULL,
  "referenceId" VARCHAR(255) NOT NULL,
  "transferType" "TransferType" NOT NULL,
  "note" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LedgerEntry_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "LedgerEntry_walletId_fkey"
    FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "LedgerEntry_walletId_referenceId_key"
  ON "LedgerEntry" ("walletId", "referenceId");
CREATE INDEX "LedgerEntry_transactionId_idx" ON "LedgerEntry" ("transactionId");
CREATE INDEX "LedgerEntry_walletId_createdAt_idx" ON "LedgerEntry" ("walletId", "createdAt");

CREATE TABLE "WalletHold" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "walletId" INTEGER NOT NULL,
  "amount" DECIMAL(20,2) NOT NULL,
  "referenceId" VARCHAR(255) NOT NULL,
  "status" "HoldStatus" NOT NULL DEFAULT 'PENDING',
  "transactionId" UUID,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WalletHold_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WalletHold_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "WalletHold_walletId_fkey"
    FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "WalletHold_walletId_referenceId_key"
  ON "WalletHold" ("walletId", "referenceId");
CREATE INDEX "WalletHold_status_expiresAt_idx" ON "WalletHold" ("status", "expiresAt");

-- Transactional outbox: a queue relay can publish these events to
-- notification-service after the money transaction commits.
CREATE TABLE "WalletOutboxEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "topic" VARCHAR(100) NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "WalletOutboxEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WalletOutboxEvent_publishedAt_createdAt_idx"
  ON "WalletOutboxEvent" ("publishedAt", "createdAt");

-- Ledger rows are accounting facts.  Database-level protection makes them
-- append-only even when a caller accidentally obtains write access.
CREATE FUNCTION prevent_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'LedgerEntry is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerEntry_append_only"
  BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
