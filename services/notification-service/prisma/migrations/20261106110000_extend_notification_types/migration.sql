-- N14a: add notification types for funding/utility/refund/KYC review events.
-- One ALTER TYPE per statement; none of these values is used in this migration.
ALTER TYPE "NotificationType" ADD VALUE 'TOPUP_SUCCEEDED';
ALTER TYPE "NotificationType" ADD VALUE 'CASHOUT_SUCCEEDED';
ALTER TYPE "NotificationType" ADD VALUE 'CASHOUT_FAILED';
ALTER TYPE "NotificationType" ADD VALUE 'UTILITY_SUCCEEDED';
ALTER TYPE "NotificationType" ADD VALUE 'UTILITY_FAILED';
ALTER TYPE "NotificationType" ADD VALUE 'UTILITY_REFUNDED';
