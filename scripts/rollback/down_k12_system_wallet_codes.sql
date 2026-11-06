-- ==============================================================================
-- ROLLBACK SCRIPT (DOWN MIGRATION): K12 - SystemWalletCode Rename
-- ==============================================================================
-- Mục đích: Đảo ngược migration 20261104103000_rename_system_wallet_codes
--   - CLEARING_TOPUP -> TOPUP_POOL
--   - SETTLEMENT     -> MAIN
--
-- Hướng dẫn chạy:
--   Từ máy host (Docker container postgres):
--     docker exec -i ptpmhdv_backend-postgres-1 psql -U postgres -d <db_name> < scripts/rollback/down_k12_system_wallet_codes.sql
--   Hoặc với psql:
--     psql -U postgres -d <db_name> -f scripts/rollback/down_k12_system_wallet_codes.sql
-- ==============================================================================

ALTER TYPE "SystemWalletCode" RENAME VALUE 'CLEARING_TOPUP' TO 'TOPUP_POOL';
ALTER TYPE "SystemWalletCode" RENAME VALUE 'SETTLEMENT' TO 'MAIN';

