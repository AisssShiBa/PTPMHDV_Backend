import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { execFileSync } from 'node:child_process';

const targetUsername = process.argv[2] || 'user1';
const targetAmount = process.argv[3] || '100000';
const adminPassword = process.argv[4] || '123456';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3000';

function getUserId(query) {
  if (query === 'user1') return '11111111-1111-4111-8111-111111111111';
  if (query === 'user2') return '22222222-2222-4222-8222-222222222222';
  try {
    const res = execFileSync('docker', [
      'exec', '-i', 'ptpmhdv_backend-postgres-1',
      'psql', '-U', 'postgres', '-d', 'auth_service',
      '-At', '-c', `SELECT id FROM "User" WHERE username='${query}' OR email='${query}';`
    ], { encoding: 'utf8', windowsHide: true });
    return res.trim() || null;
  } catch {
    return null;
  }
}

async function main() {
  console.log(`=== ADMIN NẠP TIỀN VÀO VÍ: ${targetUsername} (+${targetAmount} VND) ===\n`);

  // 1. Đăng nhập tài khoản admin để lấy JWT có quyền ADMIN
  const loginRes = await fetch(`${GATEWAY_URL}/api/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: adminPassword })
  });
  const loginData = await loginRes.json();
  if (!loginData.success) {
    throw new Error(`Đăng nhập admin thất bại: ${JSON.stringify(loginData)}`);
  }
  const adminToken = loginData.data.accessToken;
  console.log('1. Đăng nhập tài khoản admin thành công.');

  // 2. Tra cứu authUserId của user mục tiêu
  const targetUserId = getUserId(targetUsername);
  if (!targetUserId) {
    throw new Error(`Không tìm thấy người dùng ${targetUsername} trong hệ thống auth_service.`);
  }
  console.log(`2. Xác định authUserId của ${targetUsername}: ${targetUserId}`);

  // 3. Thực hiện điều chỉnh tăng số dư (CREDIT) qua API Admin Wallet
  const formattedAmount = `${Number(targetAmount).toFixed(2)}`;
  const refId = `admin-topup-${targetUsername}-${Date.now()}`;
  const adjustRes = await fetch(`${GATEWAY_URL}/api/wallets/admin/${targetUserId}/adjust`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      amount: formattedAmount,
      direction: 'CREDIT',
      referenceId: refId,
      reason: `Admin nạp ${targetAmount} VND vào ví ${targetUsername}`
    })
  });

  const adjustData = await adjustRes.json();
  if (!adjustData.success) {
    throw new Error(`Điều chỉnh số dư thất bại: ${JSON.stringify(adjustData)}`);
  }

  const newBalance = adjustData.data.userWallet.balance;
  console.log(`3. Nạp tiền thành công!`);
  console.log(`   - Người nhận: ${targetUsername}`);
  console.log(`   - Số tiền nạp: +${targetAmount} VND`);
  console.log(`   - Số dư ví mới: ${newBalance} VND`);
  console.log(`   - Transaction ID: ${adjustData.data.transactionId}`);
  console.log(`\n=== HOÀN TẤT ===`);
}

main().catch(err => {
  console.error('❌ Lỗi:', err.message);
  process.exit(1);
});
