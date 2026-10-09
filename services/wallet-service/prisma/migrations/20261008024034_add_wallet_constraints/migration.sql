-- Step 1: Pre-check constraints
DO $$ 
DECLARE
  negative_user_balance_count INT;
  negative_held_balance_count INT;
  invalid_held_balance_count INT;
BEGIN
  -- Check for user wallets with negative balance
  SELECT COUNT(*) INTO negative_user_balance_count FROM "Wallet" WHERE "ownerType" != 'SYSTEM' AND "balance" < 0;
  IF negative_user_balance_count > 0 THEN
    RAISE EXCEPTION 'Migration failed: Found % user wallets with negative balance. Please reconcile data before migrating.', negative_user_balance_count;
  END IF;

  -- Check for any wallet with negative heldBalance
  SELECT COUNT(*) INTO negative_held_balance_count FROM "Wallet" WHERE "heldBalance" < 0;
  IF negative_held_balance_count > 0 THEN
    RAISE EXCEPTION 'Migration failed: Found % wallets with negative heldBalance. Please reconcile data before migrating.', negative_held_balance_count;
  END IF;

  -- Check for user wallets where heldBalance > balance
  SELECT COUNT(*) INTO invalid_held_balance_count FROM "Wallet" WHERE "ownerType" != 'SYSTEM' AND "heldBalance" > "balance";
  IF invalid_held_balance_count > 0 THEN
    RAISE EXCEPTION 'Migration failed: Found % user wallets where heldBalance exceeds balance. Please reconcile data before migrating.', invalid_held_balance_count;
  END IF;
END $$;

-- Step 2: Add constraints safely using NOT VALID (to avoid table lock), then VALIDATE
ALTER TABLE "Wallet" DROP CONSTRAINT IF EXISTS "wallet_balance_check";
ALTER TABLE "Wallet" ADD CONSTRAINT "wallet_balance_check" CHECK ("ownerType" = 'SYSTEM' OR "balance" >= 0) NOT VALID;

ALTER TABLE "Wallet" DROP CONSTRAINT IF EXISTS "wallet_held_positive_check";
ALTER TABLE "Wallet" ADD CONSTRAINT "wallet_held_positive_check" CHECK ("heldBalance" >= 0) NOT VALID;

ALTER TABLE "Wallet" DROP CONSTRAINT IF EXISTS "wallet_held_balance_check";
ALTER TABLE "Wallet" ADD CONSTRAINT "wallet_held_balance_check" CHECK ("ownerType" = 'SYSTEM' OR "heldBalance" <= "balance") NOT VALID;

ALTER TABLE "Wallet" VALIDATE CONSTRAINT "wallet_balance_check";
ALTER TABLE "Wallet" VALIDATE CONSTRAINT "wallet_held_positive_check";
ALTER TABLE "Wallet" VALIDATE CONSTRAINT "wallet_held_balance_check";

-- Step 3: Rename walletId to sourceWalletId for semantic consistency
ALTER TABLE "WalletHold" RENAME COLUMN "walletId" TO "sourceWalletId";

-- Step 4: Add destinationWalletId to WalletHold (from schema changes)
ALTER TABLE "WalletHold" ADD COLUMN "destinationWalletId" INTEGER;
CREATE INDEX "WalletHold_destinationWalletId_idx" ON "WalletHold"("destinationWalletId");
ALTER TABLE "WalletHold" ADD CONSTRAINT "WalletHold_destinationWalletId_fkey" FOREIGN KEY ("destinationWalletId") REFERENCES "Wallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;
