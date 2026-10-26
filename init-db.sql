-- ==============================================================================
-- FINVAULT E-WALLET - DATABASE INITIALIZATION & SECURITY ROLES SCRIPT
-- Dự án: Ví điện tử FinVault
-- Phụ trách: Đạt (Lead Security & Database Infrastructure)
-- Nhiệm vụ: Tách quyền Microservice Roles & Khóa quyền Sổ cái bất biến (Ledger)
-- ==============================================================================

-- ==============================================================================
-- PHẦN 1: KHỞI TẠO 7 DATABASE DỊCH VỤ ĐỘC LẬP (DATABASE-PER-SERVICE PATTERN)
-- Sử dụng meta-command \gexec để tạo an toàn (Idempotent - không lỗi nếu đã có)
-- ==============================================================================
SELECT 'CREATE DATABASE auth_service' 
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'auth_service')\gexec

SELECT 'CREATE DATABASE user_service' 
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'user_service')\gexec

SELECT 'CREATE DATABASE merchant_service' 
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'merchant_service')\gexec

SELECT 'CREATE DATABASE wallet_service' 
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'wallet_service')\gexec

SELECT 'CREATE DATABASE payment_service' 
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'payment_service')\gexec

SELECT 'CREATE DATABASE notification_service' 
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'notification_service')\gexec

SELECT 'CREATE DATABASE admin_service' 
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'admin_service')\gexec

-- ==============================================================================
-- PHẦN 2: TẠO CÁC USER RIÊNG BIỆT CHO TỪNG MICROSERVICE (LEAST PRIVILEGE)
-- Mỗi service sở hữu 1 user riêng, không dùng chung tài khoản tối cao postgres
-- ==============================================================================
DO $$
BEGIN
  -- 1. Auth Service User
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'auth_user') THEN
    CREATE ROLE auth_user WITH LOGIN PASSWORD '{{DB_ROLE_PASSWORD}}';
  END IF;

  -- 2. User Service User
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'user_user') THEN
    CREATE ROLE user_user WITH LOGIN PASSWORD '{{DB_ROLE_PASSWORD}}';
  END IF;

  -- 3. Merchant Service User
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'merchant_user') THEN
    CREATE ROLE merchant_user WITH LOGIN PASSWORD '{{DB_ROLE_PASSWORD}}';
  END IF;

  -- 4. Wallet Service User
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'wallet_user') THEN
    CREATE ROLE wallet_user WITH LOGIN PASSWORD '{{DB_ROLE_PASSWORD}}';
  END IF;

  -- 5. Payment Service User
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'payment_user') THEN
    CREATE ROLE payment_user WITH LOGIN PASSWORD '{{DB_ROLE_PASSWORD}}';
  END IF;

  -- 6. Notification Service User
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'notification_user') THEN
    CREATE ROLE notification_user WITH LOGIN PASSWORD '{{DB_ROLE_PASSWORD}}';
  END IF;

  -- 7. Admin Service User
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'admin_user') THEN
    CREATE ROLE admin_user WITH LOGIN PASSWORD '{{DB_ROLE_PASSWORD}}';
  END IF;
END
$$;

-- ==============================================================================
-- PHẦN 3: PHÂN TÁCH QUYỀN KẾT NỐI (BLAST RADIUS ISOLATION)
-- Chỉ cấp quyền CONNECT vào đúng Database phụ trách, chặn hoàn toàn database chéo
-- ==============================================================================
GRANT CONNECT ON DATABASE auth_service TO auth_user;
GRANT CONNECT ON DATABASE user_service TO user_user;
GRANT CONNECT ON DATABASE merchant_service TO merchant_user;
GRANT CONNECT ON DATABASE wallet_service TO wallet_user;
GRANT CONNECT ON DATABASE payment_service TO payment_user;
GRANT CONNECT ON DATABASE notification_service TO notification_user;
GRANT CONNECT ON DATABASE admin_service TO admin_user;

-- Thu hồi quyền kết nối chéo giữa các service để đảm bảo Zero-Trust
REVOKE CONNECT ON DATABASE wallet_service FROM notification_user, auth_user, user_user, merchant_user;
REVOKE CONNECT ON DATABASE auth_service FROM notification_user, wallet_user, payment_user;

-- ==============================================================================
-- PHẦN 4: THIẾT LẬP AN TOÀN CHO WALLET_SERVICE & SỔ CÁI BẤT BIẾN (IMMUTABLE LEDGER)
-- ==============================================================================
\c wallet_service

-- Cấp quyền thao tác schema public cho wallet_user
GRANT USAGE, CREATE ON SCHEMA public TO wallet_user;

-- Cấp quyền đầy đủ trên các bảng nghiệp vụ thông thường (Wallet, Holds, Outbox...)
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO wallet_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO wallet_user;

-- QUY TẮC MẬT MÃ TÀI CHÍNH CỐT LÕI (FINANCIAL IMMUTABILITY RULE):
-- Đối với bảng Sổ cái LedgerEntry:
-- 1. Cho phép SELECT (truy vấn xem lịch sử biến động)
-- 2. Cho phép INSERT (ghi thêm bút toán giao dịch mới - Append-only)
-- 3. TUYỆT ĐỐI CẤM (REVOKE) quyền UPDATE và DELETE!
DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'LedgerEntry') THEN
    -- Cấp quyền ghi thêm và đọc
    GRANT SELECT, INSERT ON TABLE "LedgerEntry" TO wallet_user;
    
    -- Tước đoạt vĩnh viễn quyền sửa và xóa
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "LedgerEntry" FROM wallet_user;
  END IF;
END
$$;

-- LỚP PHÒNG THỦ THỨ 2 (DEFENSE-IN-DEPTH): TRIGGER CHẶN CẤP ĐỘ NHÂN DATABASE
-- Ngăn chặn cả các thao tác nhầm lẫn từ ứng dụng hoặc Superuser
CREATE OR REPLACE FUNCTION prevent_ledger_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'FATAL SECURITY: Bảng sổ cái LedgerEntry là bất biến (Immutable Ledger). Mọi hành vi UPDATE hoặc DELETE đều bị nghiêm cấm!';
END;
$$ LANGUAGE plpgsql;

-- Gắn Trigger vào bảng LedgerEntry nếu bảng đã tồn tại
DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'LedgerEntry') THEN
    DROP TRIGGER IF EXISTS trg_prevent_ledger_update ON "LedgerEntry";
    CREATE TRIGGER trg_prevent_ledger_update
    BEFORE UPDATE OR DELETE ON "LedgerEntry"
    FOR EACH ROW
    EXECUTE FUNCTION prevent_ledger_modification();
  END IF;
END
$$;