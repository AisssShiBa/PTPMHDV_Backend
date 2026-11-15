import { createRequire } from 'node:module';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const bcrypt = require(resolve(root, 'services/payment-service/node_modules/bcrypt'));
const { PrismaClient: WalletPrisma } = require(resolve(root, 'services/wallet-service/node_modules/@prisma/client'));

const WALLET_DB_URL = process.env.WALLET_DATABASE_URL ||
  'postgresql://postgres:404897ba313a20d9a166a1db0625276a77186fc0160c690a5e6e93ee09e06720@localhost:5432/wallet_service?schema=public';
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || '2e0bccb19255393af31732c39143d9ac47bdd997312b2c636872590ac7cdff4a';

const prisma = new WalletPrisma({
  datasources: { db: { url: WALLET_DB_URL } }
});

function executeSql(database, sqlQuery) {
  const result = execFileSync('docker', [
    'exec', '-i', 'ptpmhdv_backend-postgres-1',
    'psql', '-U', 'postgres', '-d', database,
    '-At', '-v', 'ON_ERROR_STOP=1', '-c', sqlQuery
  ], { encoding: 'utf8', windowsHide: true });
  return result.trim();
}

async function flushRedis() {
  try {
    execFileSync('docker', [
      'exec', 'ptpmhdv_backend-redis-1',
      'redis-cli', '-a', REDIS_PASSWORD, 'flushall'
    ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
  } catch (e) {
    // ignore
  }
}

async function main() {
  console.log('=== BẮT ĐẦU THIẾT LẬP 2 TÀI KHOẢN NGƯỜI DÙNG & VÍ ADMIN ÂM -200.000Đ ===\n');

  // Mật khẩu và mã PIN chuẩn: 123456
  const DEFAULT_PASSWORD = 'Password123!';
  const SIMPLE_PASSWORD = '123456';
  const DEFAULT_PIN = '123456';

  const passwordHash = bcrypt.hashSync(SIMPLE_PASSWORD, 10);
  const pinHash = bcrypt.hashSync(DEFAULT_PIN, 10);

  const ACCOUNTS = [
    {
      key: 'user1',
      id: '11111111-1111-4111-8111-111111111111',
      username: 'user1',
      email: 'user1@demo.vn',
      firstName: 'Văn A',
      lastName: 'Nguyễn',
      fullName: 'Nguyễn Văn A',
      phone: '0901111111',
      role: 'USER',
      balance: 100000,
      tier: 2
    },
    {
      key: 'user2',
      id: '22222222-2222-4222-8222-222222222222',
      username: 'user2',
      email: 'user2@demo.vn',
      firstName: 'Thị B',
      lastName: 'Trần',
      fullName: 'Trần Thị B',
      phone: '0902222222',
      role: 'USER',
      balance: 100000,
      tier: 2
    },
    {
      key: 'admin',
      id: '33333333-3333-4333-8333-333333333333',
      username: 'admin',
      email: 'admin@demo.vn',
      firstName: 'Quản Trị',
      lastName: 'Hệ Thống',
      fullName: 'Quản Trị Viên (Admin)',
      phone: '0903333333',
      role: 'ADMIN',
      balance: 0,
      tier: 2
    },
    {
      key: 'annguyen',
      id: '44444444-4444-4444-8444-444444444444',
      username: 'annguyen',
      email: 'annguyen@demo.vn',
      firstName: 'An',
      lastName: 'Nguyễn',
      fullName: 'An Nguyễn (Khách Hàng)',
      phone: '0904444444',
      role: 'USER',
      balance: 0,
      tier: 2
    }
  ];

  // 1. Dọn dẹp dữ liệu payment và hold cũ không cần thiết ("các payment khác thì ko cần tạo đủ ko dư")
  console.log('1. Làm sạch bảng Payment, OutboxEvent, UsedTransactionToken...');
  executeSql('payment_service', `
    TRUNCATE TABLE "Payment", "PaymentHistory", "OutboxEvent", "UsedTransactionToken" CASCADE;
  `);

  // 2. Làm sạch sổ cái trước khi dọn ví
  console.log('2. Làm sạch LedgerEntry, WalletHold, Anomaly, ReconciliationReport...');
  executeSql('wallet_service', `
    TRUNCATE TABLE "WalletHold", "AnomalyAdjustment", "ReconciliationAnomaly", "ReconciliationReport", "UserDailyUsage" CASCADE;
    ALTER TABLE "LedgerEntry" DISABLE TRIGGER "LedgerEntry_append_only";
    TRUNCATE TABLE "LedgerEntry" CASCADE;
    ALTER TABLE "LedgerEntry" ENABLE TRIGGER "LedgerEntry_append_only";
  `);

  // 2. Tạo hoặc cập nhật tài khoản trong auth_service và user_service
  console.log('3. Thiết lập thông tin người dùng trong auth_service và user_service:');
  const userMap = {};

  for (const acc of ACCOUNTS) {
    // 2.1. auth_service: User
    executeSql('auth_service', `
      DELETE FROM "UserPin" WHERE "userId" IN (SELECT id FROM "User" WHERE username='${acc.username}' OR email='${acc.email}');
      DELETE FROM "Session" WHERE "userId" IN (SELECT id FROM "User" WHERE username='${acc.username}' OR email='${acc.email}');
      DELETE FROM "User" WHERE username='${acc.username}' OR email='${acc.email}';
      INSERT INTO "User" ("id", "username", "email", "password", "firstName", "lastName", "role", "createdAt")
      VALUES ('${acc.id}', '${acc.username}', '${acc.email}', '${passwordHash}', '${acc.firstName}', '${acc.lastName}', '${acc.role}', NOW());
    `);

    // 2.2. auth_service: UserPin
    executeSql('auth_service', `
      INSERT INTO "UserPin" ("id", "userId", "pinHash", "failedAttempts", "lockedUntil", "createdAt", "updatedAt")
      VALUES ('${randomUUID()}', '${acc.id}', '${pinHash}', 0, NULL, NOW(), NOW());
    `);

    // 2.3. user_service: users
    executeSql('user_service', `
      DELETE FROM users WHERE auth_user_id='${acc.id}' OR email='${acc.email}';
      INSERT INTO users ("id", "auth_user_id", "email", "full_name", "phone", "kyc_status", "kyc_tier", "created_at", "updated_at")
      VALUES ('${randomUUID()}', '${acc.id}', '${acc.email}', '${acc.fullName}', '${acc.phone}', 'APPROVED', ${acc.tier}, NOW(), NOW());
    `);

    userMap[acc.key] = acc;
    console.log(`   - Tạo thành công [${acc.role}]: username='${acc.username}', email='${acc.email}', password='${SIMPLE_PASSWORD}', PIN='${DEFAULT_PIN}'`);
  }

  // 3. Đảm bảo các ví hệ thống tồn tại trong wallet_service
  console.log('\n4. Thiết lập ví hệ thống (SYSTEM):');
  const systemCodes = ['CLEARING_TOPUP', 'SETTLEMENT', 'FEE'];
  for (const code of systemCodes) {
    const exists = await prisma.wallet.findUnique({ where: { systemCode: code } });
    if (!exists) {
      await prisma.wallet.create({
        data: {
          ownerType: 'SYSTEM',
          systemCode: code,
          balance: 0,
          heldBalance: 0,
          currency: 'VND',
          status: 'ACTIVE',
          kycTier: 0
        }
      });
    }
  }

  // Xóa các ví người dùng thừa cũ
  const keepUserIds = ACCOUNTS.map(a => `'${a.id}'`).join(',');
  executeSql('wallet_service', `
    DELETE FROM "Wallet" WHERE "ownerType" = 'USER' AND "userId" NOT IN (${keepUserIds});
  `);

  // Tạo hoặc cập nhật ví cho các tài khoản
  for (const acc of ACCOUNTS) {
    let wallet = await prisma.wallet.findUnique({
      where: { userId_ownerType: { userId: acc.id, ownerType: 'USER' } }
    });
    if (!wallet) {
      wallet = await prisma.wallet.create({
        data: {
          userId: acc.id,
          ownerType: 'USER',
          balance: acc.balance,
          heldBalance: 0,
          kycTier: acc.tier,
          currency: 'VND',
          status: 'ACTIVE'
        }
      });
    } else {
      wallet = await prisma.wallet.update({
        where: { id: wallet.id },
        data: {
          balance: acc.balance,
          heldBalance: 0,
          kycTier: acc.tier,
          status: 'ACTIVE'
        }
      });
    }
    acc.walletId = wallet.id;
  }

  // 4. Cập nhật số dư ví hệ thống:
  // User 1 (100k) + User 2 (100k) = 200k
  // Ví CLEARING_TOPUP (ví admin đối ứng) = -200k
  const totalUserBalance = ACCOUNTS.reduce((sum, a) => sum + a.balance, 0); // 200,000
  const clearingWallet = await prisma.wallet.findUniqueOrThrow({ where: { systemCode: 'CLEARING_TOPUP' } });
  const settlementWallet = await prisma.wallet.findUniqueOrThrow({ where: { systemCode: 'SETTLEMENT' } });
  const feeWallet = await prisma.wallet.findUniqueOrThrow({ where: { systemCode: 'FEE' } });

  await prisma.wallet.update({
    where: { id: clearingWallet.id },
    data: { balance: -totalUserBalance, heldBalance: 0 }
  });
  await prisma.wallet.update({
    where: { id: settlementWallet.id },
    data: { balance: 0, heldBalance: 0 }
  });
  await prisma.wallet.update({
    where: { id: feeWallet.id },
    data: { balance: 0, heldBalance: 0 }
  });

  console.log(`   - Ví CLEARING_TOPUP (ví admin đối ứng hệ thống): ${-totalUserBalance} VND`);
  console.log(`   - Ví SETTLEMENT: 0 VND`);
  console.log(`   - Ví FEE: 0 VND`);

  // 5. Khởi tạo sổ cái cân bằng tuyệt đối (Double-entry Ledger)
  console.log('\n5. Khởi tạo sổ cái kép (LedgerEntry):');

  let runningClearingBal = 0;
  for (const acc of ACCOUNTS) {
    if (acc.balance > 0) {
      const txnId = randomUUID();
      const refId = `seed-${acc.username}-${Date.now()}`;
      runningClearingBal -= acc.balance;

      // DEBIT CLEARING_TOPUP
      await prisma.ledgerEntry.create({
        data: {
          transactionId: txnId,
          walletId: clearingWallet.id,
          direction: 'DEBIT',
          amount: acc.balance,
          balanceAfter: runningClearingBal,
          referenceId: `ref-clr-${refId}`,
          transferType: 'TOPUP',
          note: `Seed funding debit for ${acc.username}`
        }
      });

      // CREDIT User Wallet
      await prisma.ledgerEntry.create({
        data: {
          transactionId: txnId,
          walletId: acc.walletId,
          direction: 'CREDIT',
          amount: acc.balance,
          balanceAfter: acc.balance,
          referenceId: `ref-usr-${refId}`,
          transferType: 'TOPUP',
          note: `Seed funding credit for ${acc.username}`
        }
      });

      console.log(`   - [Bút toán TOPUP] +${acc.balance} VND cho ${acc.username} (DEBIT CLEARING_TOPUP: ${runningClearingBal} VND, CREDIT Ví ${acc.username})`);
    }
  }

  // 6. Xóa cache Redis
  await flushRedis();
  console.log('\n6. Đã xóa sạch cache Redis.');

  console.log('\n=== HOÀN TẤT THIẾT LẬP DỮ LIỆU ===');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());