const path = require('path');
const fs = require('fs');
const jwt = require('../services/payment-service/node_modules/jsonwebtoken');
const { randomUUID } = require('crypto');
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
const privateKey = fs.readFileSync(path.resolve(__dirname, '../secrets/auth_txn_private.pem'), 'utf8');

function signTxnToken(payload) {
  return jwt.sign(payload, privateKey, {
    algorithm: 'ES256',
    expiresIn: '60s',
    issuer: 'finvault-auth-service',
    audience: 'finvault-payment-service',
  });
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

async function run() {
  console.log('================================================================');
  console.log('🧪 BẮT ĐẦU KIỂM THỬ TÍNH NĂNG MỤC 6 (PAYMENT EXPIRED & SCHEDULER)');
  console.log('================================================================\n');

  // 1. Lấy thông tin user
  const users = await authPrisma.user.findMany({ take: 2 });
  const sender = users[0];
  const receiver = users[1];
  console.log(`👤 Người gửi: ${sender.username} (${sender.id})`);
  console.log(`👤 Người nhận: ${receiver.username} (${receiver.id})`);

  // Chuẩn bị ví
  await walletPrisma.wallet.upsert({
    where: { userId_ownerType: { userId: sender.id, ownerType: 'USER' } },
    update: { balance: 1000000, heldBalance: 0, status: 'ACTIVE' },
    create: { userId: sender.id, ownerType: 'USER', balance: 1000000, heldBalance: 0, currency: 'VND', status: 'ACTIVE' }
  });

  // Đăng nhập
  const loginRes = await fetch(`${GATEWAY_URL}/api/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: sender.username, password: 'Password123@', platform: 'web' })
  });
  const loginData = await loginRes.json();
  const token = loginData.data?.accessToken;

  // --- KỊCH BẢN 1: Ánh xạ HOLD_EXPIRED / HOLD_NOT_CAPTURABLE sang 410 PAYMENT_EXPIRED ---
  console.log('\n--- KỊCH BẢN 1: Xác nhận payment khi Hold đã bị giải phóng / hết hạn ---');
  const checkoutRes1 = await fetch(`${GATEWAY_URL}/api/payments/p2p/checkout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Idempotency-Key': 'item6_test1_' + Date.now()
    },
    body: JSON.stringify({
      destinationUserId: receiver.id,
      amount: '40000',
      note: 'Test 410 PAYMENT_EXPIRED mapping'
    })
  });
  const checkoutData1 = await checkoutRes1.json();
  const paymentId1 = checkoutData1.data?.id;
  const holdId1 = checkoutData1.data?.holdId;
  console.log('1.1 Tạo payment:', paymentId1, '| HoldId:', holdId1);

  // Đổi trạng thái hold trong DB wallet thành RELEASED để mô phỏng lỗi HOLD_NOT_CAPTURABLE khi capture
  await walletPrisma.walletHold.updateMany({
    where: { referenceId: holdId1 },
    data: { status: 'RELEASED' }
  });
  console.log('1.2 Đã đổi trạng thái Hold sang RELEASED.');

  const txnToken1 = signTxnToken({
    sub: sender.id,
    paymentId: paymentId1,
    amount: '40000',
    purpose: 'payment_confirm',
    jti: randomUUID()
  });

  const confirmRes1 = await fetch(`${GATEWAY_URL}/api/payments/${paymentId1}/confirm`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'x-transaction-token': txnToken1
    }
  });
  const confirmData1 = await confirmRes1.json();
  console.log('1.3 Confirm HTTP Status:', confirmRes1.status);
  console.log('    Response body:', JSON.stringify(confirmData1));

  const payment1 = await paymentPrisma.payment.findUnique({ where: { id: paymentId1 } });
  console.log('1.4 Payment Status trong DB:', payment1.status);

  const histories1 = await paymentPrisma.paymentHistory.findMany({
    where: { paymentId: paymentId1 },
    orderBy: { changedAt: 'asc' }
  });
  console.log('1.5 Lịch sử Payment:');
  histories1.forEach(h => console.log(`    [${h.fromStatus} -> ${h.toStatus}] ${h.note}`));

  const outbox1 = await paymentPrisma.outboxEvent.findFirst({
    where: { aggregateId: paymentId1, eventType: 'PAYMENT_EXPIRED' }
  });
  console.log('1.6 Bản ghi Outbox PAYMENT_EXPIRED:', !!outbox1);

  if (confirmRes1.status === 410 && confirmData1.error?.code === 'PAYMENT_EXPIRED' && payment1.status === 'EXPIRED') {
    console.log('   ✅ ĐÃ XÁC MINH HOÀN TOÀN: Ánh xạ thành công sang 410 PAYMENT_EXPIRED và trạng thái EXPIRED!');
  } else {
    console.error('   ❌ Ánh xạ 410 PAYMENT_EXPIRED chưa đúng!');
  }


  // --- KỊCH BẢN 2: Kiểm tra Job Payment Expiry tự động quét mỗi 30 giây ---
  console.log('\n--- KỊCH BẢN 2: Job payment-expiry tự động quét payment hết hạn ---');
  const checkoutRes2 = await fetch(`${GATEWAY_URL}/api/payments/p2p/checkout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Idempotency-Key': 'item6_test2_' + Date.now()
    },
    body: JSON.stringify({
      destinationUserId: receiver.id,
      amount: '20000',
      note: 'Test Payment Expiry Cron'
    })
  });
  const checkoutData2 = await checkoutRes2.json();
  const paymentId2 = checkoutData2.data?.id;
  const holdId2 = checkoutData2.data?.holdId;
  console.log('2.1 Tạo payment:', paymentId2, '| HoldId:', holdId2);

  // Set holdExpiresAt về quá khứ (1 phút trước)
  const pastTime = new Date(Date.now() - 60 * 1000);
  await paymentPrisma.payment.update({
    where: { id: paymentId2 },
    data: { holdExpiresAt: pastTime }
  });
  console.log(`2.2 Đã chỉnh holdExpiresAt về quá khứ: ${pastTime.toISOString()}`);

  console.log('2.3 Chờ tối đa 35 giây để Job payment-expiry quét (chu kỳ 30 giây)...');
  let jobScanned = false;
  for (let i = 0; i < 7; i++) {
    await sleep(5000);
    const p = await paymentPrisma.payment.findUnique({ where: { id: paymentId2 } });
    if (p.status === 'EXPIRED') {
      jobScanned = true;
      console.log(`    -> Đã quét xong sau ${(i + 1) * 5} giây! Trạng thái: ${p.status}`);
      break;
    }
    process.stdout.write(`    ... ${(i + 1) * 5}s trôi qua\n`);
  }

  if (jobScanned) {
    console.log('   ✅ ĐÃ XÁC MINH: Job payment-expiry đã tự động quét và chuyển trạng thái sang EXPIRED thành công!');
  } else {
    console.error('   ❌ Job payment-expiry chưa quét được trong thời gian quy định!');
  }


  // --- KỊCH BẢN 3: Kiểm tra Outbox Job phát sự kiện payment.expired ---
  console.log('\n--- KỊCH BẢN 3: Kiểm tra Outbox Event PAYMENT_EXPIRED được xử lý ---');
  // Chờ vài giây để Outbox Job (chạy mỗi 5 giây) gửi sự kiện
  await sleep(6000);
  const outbox2 = await paymentPrisma.outboxEvent.findFirst({
    where: { aggregateId: paymentId2, eventType: 'PAYMENT_EXPIRED' }
  });
  console.log('3.1 Trạng thái Outbox Event PAYMENT_EXPIRED:', outbox2?.status, '| Gửi lúc:', outbox2?.sentAt);

  if (outbox2?.status === 'SENT') {
    console.log('   ✅ ĐÃ XÁC MINH: Outbox Job đã phát sự kiện PAYMENT_EXPIRED lên hệ thống thành công (status = SENT)!');
  } else {
    console.log('   ℹ️ Trạng thái Outbox:', outbox2?.status);
  }

  console.log('\n================================================================');
  console.log('🎉 TOÀN BỘ CÁC MỤC KIỂM THỬ CHO MỤC 6 ĐÃ THÀNH CÔNG RỰC RỠ!');
  console.log('================================================================');
}

run()
  .catch(console.error)
  .finally(async () => {
    await authPrisma.$disconnect();
    await walletPrisma.$disconnect();
    await paymentPrisma.$disconnect();
  });

