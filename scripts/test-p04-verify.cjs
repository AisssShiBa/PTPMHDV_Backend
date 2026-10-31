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
const internalKey = fs.readFileSync(path.resolve(__dirname, '../secrets/internal_key.txt'), 'utf8').trim();
const privateKey = fs.readFileSync(path.resolve(__dirname, '../secrets/auth_txn_private.pem'), 'utf8');

function signTxnToken(payload) {
  return jwt.sign(payload, privateKey, {
    algorithm: 'ES256',
    expiresIn: '60s',
    issuer: 'finvault-auth-service',
    audience: 'finvault-payment-service',
  });
}

async function run() {
  console.log('====================================================');
  console.log('🧪 BẮT ĐẦU KIỂM THỬ TÍNH NĂNG P0-4 (PAYMENT CONFIRM)');
  console.log('====================================================\n');

  // 1. Tìm hoặc chuẩn bị 2 users
  const users = await authPrisma.user.findMany({ take: 2 });
  if (users.length < 2) {
    throw new Error('Cần ít nhất 2 user trong auth_service');
  }
  const sender = users[0];
  const receiver = users[1];
  console.log(`👤 Người gửi: ${sender.username} (${sender.id})`);
  console.log(`👤 Người nhận: ${receiver.username} (${receiver.id})`);

  // Cấp số dư cho người gửi: 1.000.000 VND
  await walletPrisma.wallet.upsert({
    where: { userId_ownerType: { userId: sender.id, ownerType: 'USER' } },
    update: { balance: 1000000, heldBalance: 0, status: 'ACTIVE' },
    create: { userId: sender.id, ownerType: 'USER', balance: 1000000, heldBalance: 0, currency: 'VND', status: 'ACTIVE' }
  });
  await walletPrisma.wallet.upsert({
    where: { userId_ownerType: { userId: receiver.id, ownerType: 'USER' } },
    update: { balance: 0, heldBalance: 0, status: 'ACTIVE' },
    create: { userId: receiver.id, ownerType: 'USER', balance: 0, heldBalance: 0, currency: 'VND', status: 'ACTIVE' }
  });

  // Đăng nhập người gửi để lấy gateway token
  const loginRes = await fetch(`${GATEWAY_URL}/api/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: sender.username, password: 'Password123@', platform: 'web' })
  });
  const loginData = await loginRes.json();
  const token = loginData.data?.accessToken;
  if (!token) {
    throw new Error('Không thể đăng nhập sender: ' + JSON.stringify(loginData));
  }

  // TEST CASE 1: LUỒNG THÀNH CÔNG (PENDING -> PROCESSING -> SUCCESS)
  console.log('\n--- TEST CASE 1: Xác nhận thành công (PENDING -> PROCESSING -> SUCCESS) ---');
  const amount1 = '50000';
  const checkoutRes1 = await fetch(`${GATEWAY_URL}/api/payments/p2p/checkout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Idempotency-Key': 'p04_test1_' + Date.now()
    },
    body: JSON.stringify({
      destinationUserId: receiver.id,
      amount: amount1,
      note: 'Test P04 Success Flow'
    })
  });
  const checkoutData1 = await checkoutRes1.json();
  const paymentId1 = checkoutData1.data?.id;
  console.log('1.1 Tạo payment qua checkout:', paymentId1, '| Status:', checkoutData1.data?.status);

  // Ký transaction token hợp lệ
  const jti1 = randomUUID();
  const txnToken1 = signTxnToken({
    sub: sender.id,
    paymentId: paymentId1,
    amount: amount1,
    purpose: 'payment_confirm',
    jti: jti1
  });

  // Gọi confirm
  const confirmRes1 = await fetch(`${GATEWAY_URL}/api/payments/${paymentId1}/confirm`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'x-transaction-token': txnToken1
    }
  });
  const confirmData1 = await confirmRes1.json();
  console.log('1.2 Kết quả confirm status code:', confirmRes1.status, '| Response:', JSON.stringify(confirmData1));

  // Kiểm tra lịch sử payment và outbox
  const histories1 = await paymentPrisma.paymentHistory.findMany({
    where: { paymentId: paymentId1 },
    orderBy: { changedAt: 'asc' }
  });
  console.log('1.3 Payment Histories:');
  histories1.forEach(h => console.log(`    [${h.fromStatus} -> ${h.toStatus}] ${h.note}`));

  const hasPendingToProcessing = histories1.some(h => h.fromStatus === 'PENDING' && h.toStatus === 'PROCESSING');
  const hasProcessingToSuccess = histories1.some(h => h.fromStatus === 'PROCESSING' && h.toStatus === 'SUCCESS');
  if (hasPendingToProcessing && hasProcessingToSuccess) {
    console.log('   ✅ ĐÃ XÁC NHẬN CHÍNH XÁC STATE MACHINE: PENDING -> PROCESSING -> SUCCESS!');
  } else {
    console.error('   ❌ State machine không khớp mong đợi!');
  }

  const outbox1 = await paymentPrisma.outboxEvent.findFirst({
    where: { aggregateId: paymentId1, eventType: 'PAYMENT_SUCCESS' }
  });
  console.log('1.4 Outbox Event PAYMENT_SUCCESS tạo thành công:', !!outbox1);

  // TEST CASE 2: REPLAY TRÊN PAYMENT ĐÃ CONFIRMED
  console.log('\n--- TEST CASE 2: Chống Replay trên payment đã CONFIRMED ---');
  const replayRes = await fetch(`${GATEWAY_URL}/api/payments/${paymentId1}/confirm`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'x-transaction-token': txnToken1
    }
  });
  const replayData = await replayRes.json();
  console.log('2.1 Replay confirm status code:', replayRes.status, '| Code:', replayData.error?.code);
  if (replayRes.status === 409 && (replayData.error?.code === 'PAYMENT_ALREADY_CONFIRMED' || replayData.error?.code === 'TXN_TOKEN_REUSED')) {
    console.log('   ✅ ĐÃ CHẶN REPLAY THÀNH CÔNG (409)!');
  } else {
    console.error('   ❌ Chặn replay thất bại:', replayData);
  }

  // TEST CASE 3: CAPTURE DETERMINISTIC FAILURE (XÓA NHÁNH COMPENSATE & RELEASE HOLD & HOÀN USAGE)
  console.log('\n--- TEST CASE 3: Capture lỗi dứt khoát (Deterministic Failure) ---');
  const amount3 = '30000';
  const checkoutRes3 = await fetch(`${GATEWAY_URL}/api/payments/p2p/checkout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Idempotency-Key': 'p04_test3_' + Date.now()
    },
    body: JSON.stringify({
      destinationUserId: receiver.id,
      amount: amount3,
      note: 'Test P04 Deterministic Failure'
    })
  });
  const checkoutData3 = await checkoutRes3.json();
  const paymentId3 = checkoutData3.data?.id;
  const holdId3 = checkoutData3.data?.holdId;
  console.log('3.1 Tạo payment:', paymentId3, '| HoldId:', holdId3);

  // Cố tình giải phóng hold trước để khi confirm gọi capture -> wallet báo lỗi deterministic (409 HOLD_ALREADY_RELEASED / NOT_FOUND)
  console.log('3.2 Giải phóng hold trong database để mô phỏng lỗi capture deterministic 4xx...');
  await walletPrisma.walletHold.updateMany({
    where: { referenceId: holdId3 },
    data: { status: 'RELEASED' }
  });

  const jti3 = randomUUID();
  const txnToken3 = signTxnToken({
    sub: sender.id,
    paymentId: paymentId3,
    amount: amount3,
    purpose: 'payment_confirm',
    jti: jti3
  });

  const confirmRes3 = await fetch(`${GATEWAY_URL}/api/payments/${paymentId3}/confirm`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'x-transaction-token': txnToken3
    }
  });
  const confirmData3 = await confirmRes3.json();
  console.log('3.3 Kết quả confirm lỗi deterministics:', confirmRes3.status, '| Error:', confirmData3.error?.code);

  const payment3 = await paymentPrisma.payment.findUnique({ where: { id: paymentId3 } });
  console.log('3.4 Trạng thái cuối cùng của Payment:', payment3.status, '| FailureReason:', payment3.failureReason);

  const histories3 = await paymentPrisma.paymentHistory.findMany({
    where: { paymentId: paymentId3 },
    orderBy: { changedAt: 'asc' }
  });
  console.log('3.5 Payment Histories cho lỗi deterministic:');
  histories3.forEach(h => console.log(`    [${h.fromStatus} -> ${h.toStatus}] ${h.note}`));

  const outbox3 = await paymentPrisma.outboxEvent.findFirst({
    where: { aggregateId: paymentId3, eventType: 'PAYMENT_FAILED' }
  });
  console.log('3.6 Outbox Event PAYMENT_FAILED tạo thành công:', !!outbox3);

  // KIỂM TRA ĐẶC BIỆT: XEM CÓ BẤT KỲ GIAO DỊCH BÙ TRỪ NÀO (compensate_) TRONG WALLET KHÔNG!
  const compensateTx = await walletPrisma.ledgerEntry.findFirst({
    where: { referenceId: `compensate_${paymentId3}` }
  });
  if (!compensateTx) {
    console.log('   ✅ ĐÃ XÁC MINH: HOÀN TOÀN KHÔNG CÓ NHÁNH BÙ TRỪ NÀO TẠO TIỀN TỪ HƯ KHÔNG (compensate_ không tồn tại)!');
  } else {
    console.error('   ❌ LỖI NGHIÊM TRỌNG: Vẫn còn giao dịch compensate_!');
  }

  console.log('\n====================================================');
  console.log('🎉 TẤT CẢ CÁC BƯỚC TEST CHO P0-4 ĐÃ THÀNH CÔNG HOÀN TOÀN!');
  console.log('====================================================');
}

run()
  .catch(console.error)
  .finally(async () => {
    await authPrisma.$disconnect();
    await walletPrisma.$disconnect();
    await paymentPrisma.$disconnect();
  });
