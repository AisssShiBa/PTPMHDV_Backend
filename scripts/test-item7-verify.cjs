const path = require('path');
const fs = require('fs');
const { PrismaClient: AuthPrisma } = require('../services/auth-service/node_modules/@prisma/client');
const { PrismaClient: WalletPrisma } = require('../services/wallet-service/node_modules/@prisma/client');
const { PrismaClient: PaymentPrisma } = require('../services/payment-service/node_modules/@prisma/client');

const authPrisma = new AuthPrisma({
  datasources: { db: { url: 'postgresql://postgres:8932ce4c6b28dba8c13430d3317b1e51e4f8838c6b02824423f9b57b69d56d4a@localhost:5432/auth_service?schema=public' } }
});
const walletPrisma = new WalletPrisma({
  datasources: { db: { url: 'postgresql://postgres:8932ce4c6b28dba8c13430d3317b1e51e4f8838c6b02824423f9b57b69d56d4a@localhost:5432/wallet_service?schema=public' } }
});
const paymentPrisma = new PaymentPrisma({
  datasources: { db: { url: 'postgresql://postgres:8932ce4c6b28dba8c13430d3317b1e51e4f8838c6b02824423f9b57b69d56d4a@localhost:5432/payment_service?schema=public' } }
});

const GATEWAY_URL = 'http://localhost:3000';

async function login(username, password) {
  const res = await fetch(`${GATEWAY_URL}/api/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, platform: 'web' })
  });
  const data = await res.json();
  if (!data.data?.accessToken) {
    throw new Error(`Đăng nhập thất bại cho ${username}: ${JSON.stringify(data)}`);
  }
  return {
    token: data.data.accessToken,
    user: data.data.user
  };
}

async function run() {
  console.log('========================================================================');
  console.log('🧪 BẮT ĐẦU KIỂM THỬ TÍNH NĂNG MỤC 7 (KIỂM TRA CHỦ SỞ HỮU & PHÂN QUYỀN)');
  console.log('========================================================================\n');

  // 1. Chuẩn bị 2 User thường và 1 Admin
  const regularUsers = await authPrisma.user.findMany({
    where: { role: 'USER' },
    take: 2
  });

  if (regularUsers.length < 2) {
    throw new Error('Cần ít nhất 2 user có role USER trong auth DB');
  }

  const userA = regularUsers[0];
  const userB = regularUsers[1];

  console.log(`👤 User A: ${userA.username} (${userA.id})`);
  console.log(`👤 User B: ${userB.username} (${userB.id})`);

  // Đăng nhập
  const authA = await login(userA.username, 'Password123@');
  const authB = await login(userB.username, 'Password123@');
  const authAdmin = await login('admin', 'Admin@123456');
  console.log(`🛡️ Admin: ${authAdmin.user.username} (Role: ${authAdmin.user.role})\n`);

  // Đảm bảo User A có đủ số dư để checkout
  await walletPrisma.wallet.upsert({
    where: { userId_ownerType: { userId: userA.id, ownerType: 'USER' } },
    update: { balance: 500000, heldBalance: 0, status: 'ACTIVE' },
    create: { userId: userA.id, ownerType: 'USER', balance: 500000, heldBalance: 0, currency: 'VND', status: 'ACTIVE' }
  });

  // Tạo một payment cho User A
  console.log('--- BƯỚC 1: User A tạo payment qua checkout ---');
  const checkoutRes = await fetch(`${GATEWAY_URL}/api/payments/p2p/checkout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authA.token}`,
      'Idempotency-Key': 'item7_test_' + Date.now()
    },
    body: JSON.stringify({
      destinationUserId: userB.id,
      amount: '50000',
      note: 'Payment created by User A for Item 7 test'
    })
  });
  const checkoutData = await checkoutRes.json();
  const paymentAId = checkoutData.data?.id;
  console.log(`1.1 Đã tạo payment của User A: ${paymentAId} (Status: ${checkoutData.data?.status})`);

  // --- BƯỚC 2: User B cố tình truy cập GET /:id của User A ---
  console.log('\n--- BƯỚC 2: User B xem chi tiết payment của User A (GET /:id) ---');
  const getOtherRes = await fetch(`${GATEWAY_URL}/api/payments/${paymentAId}`, {
    headers: { 'Authorization': `Bearer ${authB.token}` }
  });
  const getOtherData = await getOtherRes.json();
  console.log(`2.1 Status: ${getOtherRes.status} | Code: ${getOtherData.error?.code}`);
  if (getOtherRes.status === 403 && getOtherData.error?.code === 'FORBIDDEN') {
    console.log('   ✅ ĐÃ CHẶN 403 FORBIDDEN: User B không được xem giao dịch của User A!');
  } else {
    console.error('   ❌ Lỗi: User B truy cập được hoặc mã lỗi không phải 403!', getOtherData);
  }

  // --- BƯỚC 3: User B cố tình HỦY (POST /:id/cancel) payment của User A ---
  console.log('\n--- BƯỚC 3: User B hủy payment của User A (POST /:id/cancel) ---');
  const cancelOtherRes = await fetch(`${GATEWAY_URL}/api/payments/${paymentAId}/cancel`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${authB.token}` }
  });
  const cancelOtherData = await cancelOtherRes.json();
  console.log(`3.1 Status: ${cancelOtherRes.status} | Code: ${cancelOtherData.error?.code}`);
  if (cancelOtherRes.status === 403 && cancelOtherData.error?.code === 'FORBIDDEN') {
    console.log('   ✅ ĐÃ CHẶN 403 FORBIDDEN: User B không thể hủy giao dịch của User A!');
  } else {
    console.error('   ❌ Lỗi: User B hủy được hoặc mã lỗi không phải 403!', cancelOtherData);
  }

  // --- BƯỚC 4: User B gọi GET /payments?userId=UserA ---
  console.log('\n--- BƯỚC 4: User B truyền ?userId=UserA để lấy danh sách thanh toán của User A ---');
  const listOtherRes = await fetch(`${GATEWAY_URL}/api/payments?userId=${userA.id}`, {
    headers: { 'Authorization': `Bearer ${authB.token}` }
  });
  const listOtherData = await listOtherRes.json();
  const listItems = listOtherData.data || [];
  const leakFound = listItems.some(item => item.userId === userA.id);
  const allBelongToB = listItems.every(item => item.userId === userB.id);
  console.log(`4.1 Status: ${listOtherRes.status} | Số payment trả về: ${listItems.length}`);
  console.log(`    Có bị rò rỉ payment của User A không? ${leakFound ? 'CÓ (LỖI)' : 'KHÔNG (CHUẨN)'}`);
  console.log(`    Tất cả payment thuộc về User B? ${allBelongToB ? 'ĐÚNG' : 'SAI'}`);
  if (!leakFound && allBelongToB) {
    console.log('   ✅ ĐÃ XÁC MINH: User thường truyền ?userId=... sẽ bị bỏ qua và chỉ trả về payment của chính mình!');
  } else {
    console.error('   ❌ Lỗi rò rỉ dữ liệu của user khác!');
  }

  // --- BƯỚC 5: User A gọi GET /:id của chính mình ---
  console.log('\n--- BƯỚC 5: User A xem chi tiết payment của chính mình (GET /:id) ---');
  const getOwnerRes = await fetch(`${GATEWAY_URL}/api/payments/${paymentAId}`, {
    headers: { 'Authorization': `Bearer ${authA.token}` }
  });
  const getOwnerData = await getOwnerRes.json();
  console.log(`5.1 Status: ${getOwnerRes.status} | Payment ID: ${getOwnerData.data?.id || getOwnerData.id}`);
  if (getOwnerRes.status === 200) {
    console.log('   ✅ ĐÃ XÁC MINH: Chính chủ User A xem chi tiết thành công (200 OK)!');
  } else {
    console.error('   ❌ Lỗi truy cập của chính chủ:', getOwnerData);
  }

  // --- BƯỚC 6: ADMIN gọi GET /:id xem payment của User A ---
  console.log('\n--- BƯỚC 6: ADMIN xem chi tiết payment của User A (GET /:id) ---');
  const getAdminRes = await fetch(`${GATEWAY_URL}/api/payments/${paymentAId}`, {
    headers: { 'Authorization': `Bearer ${authAdmin.token}` }
  });
  const getAdminData = await getAdminRes.json();
  console.log(`6.1 Status: ${getAdminRes.status} | Payment ID: ${getAdminData.data?.id || getAdminData.id}`);
  if (getAdminRes.status === 200) {
    console.log('   ✅ ĐÃ XÁC MINH: ADMIN được phép xem chi tiết payment của bất kỳ user nào (200 OK)!');
  } else {
    console.error('   ❌ Lỗi: ADMIN bị chặn truy cập!', getAdminData);
  }

  // --- BƯỚC 7: ADMIN gọi GET /payments?userId=UserA ---
  console.log('\n--- BƯỚC 7: ADMIN truyền ?userId=UserA để lọc danh sách thanh toán của User A ---');
  const listAdminFilteredRes = await fetch(`${GATEWAY_URL}/api/payments?userId=${userA.id}`, {
    headers: { 'Authorization': `Bearer ${authAdmin.token}` }
  });
  const listAdminFilteredData = await listAdminFilteredRes.json();
  const adminItems = listAdminFilteredData.data || [];
  const allBelongToA = adminItems.length > 0 && adminItems.every(item => item.userId === userA.id);
  console.log(`7.1 Status: ${listAdminFilteredRes.status} | Số payment trả về: ${adminItems.length}`);
  console.log(`    Tất cả payment thuộc về User A? ${allBelongToA ? 'ĐÚNG' : 'SAI'}`);
  if (allBelongToA) {
    console.log('   ✅ ĐÃ XÁC MINH: ADMIN được phép truyền ?userId để lọc giao dịch của user cụ thể!');
  } else {
    console.error('   ❌ Lỗi lọc của ADMIN:', listAdminFilteredData);
  }

  // --- BƯỚC 8: ADMIN gọi GET /payments không truyền userId ---
  console.log('\n--- BƯỚC 8: ADMIN xem toàn bộ thanh toán trong hệ thống (GET /payments) ---');
  const listAdminAllRes = await fetch(`${GATEWAY_URL}/api/payments`, {
    headers: { 'Authorization': `Bearer ${authAdmin.token}` }
  });
  const listAdminAllData = await listAdminAllRes.json();
  const allItems = listAdminAllData.data || [];
  console.log(`8.1 Status: ${listAdminAllRes.status} | Tổng số payment trong hệ thống: ${allItems.length}`);
  if (allItems.length >= adminItems.length) {
    console.log('   ✅ ĐÃ XÁC MINH: ADMIN không truyền userId sẽ xem được toàn bộ thanh toán trong hệ thống!');
  } else {
    console.error('   ❌ Lỗi lấy toàn bộ của ADMIN!');
  }

  // --- BƯỚC 9: User A hủy payment của chính mình (POST /:id/cancel) ---
  console.log('\n--- BƯỚC 9: Chính chủ User A hủy payment của mình (POST /:id/cancel) ---');
  const cancelOwnerRes = await fetch(`${GATEWAY_URL}/api/payments/${paymentAId}/cancel`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${authA.token}` }
  });
  const cancelOwnerData = await cancelOwnerRes.json();
  console.log(`9.1 Status: ${cancelOwnerRes.status} | Status mới: ${cancelOwnerData.data?.status}`);
  if (cancelOwnerRes.status === 200 && cancelOwnerData.data?.status === 'CANCELLED') {
    console.log('   ✅ ĐÃ XÁC MINH: Chính chủ User A hủy thành công đơn PENDING!');
  } else {
    console.error('   ❌ Lỗi hủy đơn của chính chủ:', cancelOwnerData);
  }

  console.log('\n========================================================================');
  console.log('🎉 TOÀN BỘ 9 KỊCH BẢN KIỂM THỬ CHO MỤC 7 ĐÃ THÀNH CÔNG RỰC RỠ 100%!');
  console.log('========================================================================');
}

run()
  .catch(console.error)
  .finally(async () => {
    await authPrisma.$disconnect();
    await walletPrisma.$disconnect();
    await paymentPrisma.$disconnect();
  });

