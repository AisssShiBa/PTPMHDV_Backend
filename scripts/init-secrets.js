/**
 * FINVAULT E-WALLET - LOCAL SECRETS INITIALIZER
 * Tác giả: Đạt (Lead Security & Database Infrastructure)
 * 
 * Mục đích:
 * Tự động tạo thư mục secrets/ và các file khóa bảo mật môi trường DEV
 * cho các thành viên trong nhóm (Khoa, Hữu, Nguyên) khi clone repo mới về máy.
 */

const fs = require('fs');
const path = require('path');

const SECRETS_DIR = path.join(__dirname, '..', 'secrets');
const ENV_FILE = path.join(__dirname, '..', '.env');
const ENV_EXAMPLE_FILE = path.join(__dirname, '..', '.env.example');

// Khóa mẫu ECDSA ES256 (NIST P-256) dùng cho môi trường kiểm thử nội bộ (Dev Stub)
const DEV_STUB_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtGfFMFMTiOTdDVxb
ByJfXc0gszqTpA2mwaMOqlbElNmhRANCAASeItQruBntlJjJYGebdKI9R51AfC1p
4WlWv0NYM5oDTY5yxIarUr6mbOyl6uzvvHjWcVhKp79tCA4v1c40qRHB
-----END PRIVATE KEY-----`;

const DEV_STUB_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEniLUK7gZ7ZSYyWBnm3SiPUedQHwt
aeFpVr9DWDOaA02OcsSGq1K+pmzspers77x41nFYSqe/bQgOL9XONKkRwQ==
-----END PUBLIC KEY-----`;

const DEFAULT_SECRETS = {
  'postgres_password.txt': 'postgres',
  'rabbitmq_pass.txt': 'admin',
  'vnp_hash_secret.txt': 'AIWWJEDQTSPYEMVZYUXJKMOZDNWFTGRQ',
  'gateway_private.pem': DEV_STUB_PRIVATE_KEY,
  'gateway_public.pem': DEV_STUB_PUBLIC_KEY
};

function init() {
  console.log('🔒 [FinVault Security] Đang khởi tạo môi trường bí mật (Secrets & Env)...');

  // 1. Tạo thư mục secrets/ nếu chưa có
  if (!fs.existsSync(SECRETS_DIR)) {
    fs.mkdirSync(SECRETS_DIR, { recursive: true });
    console.log('✅ Đã tạo thư mục: Backend/secrets/');
  }

  // 2. Tạo các file bí mật cho Docker Secrets
  let createdCount = 0;
  for (const [filename, content] of Object.entries(DEFAULT_SECRETS)) {
    const filePath = path.join(SECRETS_DIR, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content.trim(), 'utf-8');
      console.log(`   + Đã tạo file secret: secrets/${filename}`);
      createdCount++;
    }
  }

  if (createdCount === 0) {
    console.log('ℹ️  Tất cả các file bí mật trong secrets/ đã sẵn sàng.');
  }

  // 3. Tự động sao chép .env.example sang .env nếu chưa có
  if (!fs.existsSync(ENV_FILE) && fs.existsSync(ENV_EXAMPLE_FILE)) {
    fs.copyFileSync(ENV_EXAMPLE_FILE, ENV_FILE);
    console.log('✅ Đã khởi tạo file Backend/.env từ .env.example');
  } else if (fs.existsSync(ENV_FILE)) {
    console.log('ℹ️  File Backend/.env đã tồn tại.');
  }

  console.log('\n🚀 [HOÀN TẤT] Bạn có thể chạy Docker cụm 10 microservices ngay bằng lệnh:');
  console.log('   docker compose up -d --build\n');
}

init();
