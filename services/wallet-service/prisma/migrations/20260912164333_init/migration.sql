-- DropIndex
DROP INDEX "Wallet_userId_idx";

-- AlterTable
ALTER TABLE "Wallet" ALTER COLUMN "ownerType" DROP DEFAULT;

-- AlterTable
ALTER TABLE "WalletHold" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "WalletOutboxEvent" ALTER COLUMN "id" DROP DEFAULT;
