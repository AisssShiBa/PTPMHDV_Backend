-- 1. Create Enum SystemWalletCode
CREATE TYPE "SystemWalletCode" AS ENUM ('MAIN', 'FEE', 'TOPUP_POOL');

-- 2. Alter Table Wallet: add systemCode
ALTER TABLE "Wallet" ADD COLUMN "systemCode" "SystemWalletCode";

-- 3. Drop existing single unique on userId and legacy single system wallet index
DROP INDEX IF EXISTS "Wallet_userId_key";
DROP INDEX IF EXISTS "Wallet_single_system_wallet";

-- 4. Create unique index on systemCode
CREATE UNIQUE INDEX "Wallet_systemCode_key" ON "Wallet"("systemCode");

-- 5. Create compound unique index on (userId, ownerType)
CREATE UNIQUE INDEX "Wallet_userId_ownerType_key" ON "Wallet"("userId", "ownerType");

-- 6. Create index on ownerType
CREATE INDEX "Wallet_ownerType_idx" ON "Wallet"("ownerType");

-- 7. Handle existing SYSTEM wallets: map the first one to MAIN if unassigned
DO $$
DECLARE
  first_sys_id INT;
BEGIN
  SELECT id INTO first_sys_id FROM "Wallet" WHERE "ownerType" = 'SYSTEM' AND "systemCode" IS NULL ORDER BY id LIMIT 1;
  IF first_sys_id IS NOT NULL THEN
    UPDATE "Wallet" SET "systemCode" = 'MAIN' WHERE id = first_sys_id;
  END IF;
END $$;

-- 8. Seed the 3 system wallets if they do not exist
INSERT INTO "Wallet" ("systemCode", "ownerType", "balance", "heldBalance", "currency", "status", "createdAt", "updatedAt")
VALUES
  ('MAIN', 'SYSTEM', 0, 0, 'VND', 'ACTIVE', NOW(), NOW()),
  ('FEE', 'SYSTEM', 0, 0, 'VND', 'ACTIVE', NOW(), NOW()),
  ('TOPUP_POOL', 'SYSTEM', 0, 0, 'VND', 'ACTIVE', NOW(), NOW())
ON CONFLICT ("systemCode") DO NOTHING;
