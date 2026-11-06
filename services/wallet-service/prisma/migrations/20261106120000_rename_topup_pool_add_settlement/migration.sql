-- K12: align the SYSTEM wallet codes with plan §5.4.
-- TOPUP_POOL was the repo's name for the plan's CLEARING_TOPUP; renaming the
-- value (not the row) keeps the existing wallet, its balance and every ledger
-- entry that references it by id.
ALTER TYPE "SystemWalletCode" RENAME VALUE 'TOPUP_POOL' TO 'CLEARING_TOPUP';

-- A new enum value cannot be *referenced* in the transaction that adds it, and
-- Prisma runs each migration file in one transaction, so the SETTLEMENT wallet
-- row is seeded by the next migration.
ALTER TYPE "SystemWalletCode" ADD VALUE IF NOT EXISTS 'SETTLEMENT';
