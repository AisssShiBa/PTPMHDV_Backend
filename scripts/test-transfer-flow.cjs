const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { PrismaClient } = require(path.resolve(__dirname, '../services/wallet-service/node_modules/@prisma/client'));
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: 'postgresql://postgres:8932ce4c6b28dba8c13430d3317b1e51e4f8838c6b02824423f9b57b69d56d4a@localhost:5432/wallet_service?schema=public'
    }
  }
});

const GATEWAY_URL = 'http://localhost:3000';
const internalKey = fs.readFileSync(path.resolve(__dirname, '../secrets/internal_key.txt'), 'utf8').trim();

async function main() {
  console.log('🚀 BẮT ĐẦU TEST LUỒNG CHUYỂN TIỀN (P2P TRANSFER)\n');

  // Bước 1: Đăng nhập Người gửi (demo_user)
  console.log('1️⃣ Đăng nhập Người gửi (demo_user)...');
  const resLoginSender = await fetch(`${GATEWAY_URL}/api/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'demo_user', password: 'Password123@', platform: 'web' })
  });
  const dataSender = await resLoginSender.json();
  const tokenSender = dataSender.data?.accessToken;
  const senderId = dataSender.data?.user?.id;
  console.log(`   -> Sender: ${dataSender.data?.user?.username} (ID: ${senderId})`);

  // Bước 2: Đăng nhập Người nhận (user_moi)
  console.log('\n2️⃣ Đăng nhập Người nhận (user_moi)...');
  const resLoginReceiver = await fetch(`${GATEWAY_URL}/api/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'user_moi', password: 'Password123@', platform: 'web' })
  });
  const dataReceiver = await resLoginReceiver.json();
  const tokenReceiver = dataReceiver.data?.accessToken;
  const receiverId = dataReceiver.data?.user?.id;
  console.log(`   -> Receiver: ${dataReceiver.data?.user?.username} (ID: ${receiverId})`);

  // Bước 3: Đảm bảo cả 2 User đều đã có Ví trong database và cấp 500k cho demo_user
  console.log('\n3️⃣ Chuẩn bị ví & số dư ban đầu trong cơ sở dữ liệu:');
  const senderWallet = await prisma.wallet.upsert({
    where: { userId_ownerType: { userId: senderId, ownerType: 'USER' } },
    update: { balance: 500000, heldBalance: 0, status: 'ACTIVE' },
    create: { userId: senderId, ownerType: 'USER', balance: 500000, heldBalance: 0, currency: 'VND', status: 'ACTIVE' }
  });
  console.log(`   💰 Ví người gửi (${senderId}): Số dư = ${senderWallet.balance} VND`);

  const receiverWallet = await prisma.wallet.upsert({
    where: { userId_ownerType: { userId: receiverId, ownerType: 'USER' } },
    update: { balance: 0, heldBalance: 0, status: 'ACTIVE' },
    create: { userId: receiverId, ownerType: 'USER', balance: 0, heldBalance: 0, currency: 'VND', status: 'ACTIVE' }
  });
  console.log(`   💰 Ví người nhận (${receiverId}): Số dư = ${receiverWallet.balance} VND`);

  // Bước 4: Test API Báo giá chuyển tiền P2P (p2p/quote)
  console.log('\n4️⃣ Người gửi gọi API lấy Báo giá P2P (POST /api/payments/p2p/quote)...');
  const resQuote = await fetch(`${GATEWAY_URL}/api/payments/p2p/quote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenSender}`
    },
    body: JSON.stringify({
      destinationUserId: receiverId,
      amount: '100000'
    })
  });
  const textQuote = await resQuote.text();
  console.log('   Status:', resQuote.status, 'Response:', textQuote);

  // Bước 5: Test API Checkout tạo thanh toán (Hold tiền)
  console.log('\n5️⃣ Người gửi gọi API Checkout (POST /api/payments/checkout)...');
  const idempotencyKey = 'p2p_idemp_' + Date.now();
  const resCheckout = await fetch(`${GATEWAY_URL}/api/payments/checkout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenSender}`
    },
    body: JSON.stringify({
      amount: '100000',
      type: 'WALLET_TRANSFER',
      referenceId: receiverId,
      callbackTopic: 'payment.p2p.events',
      idempotencyKey: idempotencyKey
    })
  });
  const checkoutResult = await resCheckout.json();
  console.log('   📦 Kết quả Checkout:', checkoutResult);
  const paymentId = checkoutResult.data?.id;

  // Bước 6: Kiểm tra số dư & tiền tạm giữ (Hold) trên ví người gửi
  console.log('\n6️⃣ Kiểm tra trạng thái ví người gửi sau khi Checkout (Hold tiền):');
  const heldSenderWallet = await prisma.wallet.findUnique({
    where: { userId_ownerType: { userId: senderId, ownerType: 'USER' } }
  });
  console.log(`   💰 Người gửi: Balance = ${heldSenderWallet.balance} VND | Held = ${heldSenderWallet.heldBalance} VND | Khả dụng = ${Number(heldSenderWallet.balance) - Number(heldSenderWallet.heldBalance)} VND`);

  // Bước 7: Xác nhận thanh toán (Confirm payment & Capture hold)
  console.log('\n7️⃣ Hệ thống/User Xác nhận thanh toán (POST /api/payments/:id/confirm)...');
  const cmd = `docker compose exec payment-service wget -qO- --header="x-internal-key: ${internalKey}" --post-data="" http://localhost:3005/api/payments/${paymentId}/confirm`;
  const confirmOutput = execSync(cmd, { encoding: 'utf8', cwd: path.resolve(__dirname, '..') });
  const confirmResult = JSON.parse(confirmOutput.trim());
  console.log('   ✅ Kết quả Confirm:', confirmResult);

  // Bước 8: Kiểm tra số dư cuối cùng của cả 2 ví
  console.log('\n8️⃣ Kiểm tra số dư cuối cùng trong Database:');
  const finalSenderWallet = await prisma.wallet.findUnique({
    where: { userId_ownerType: { userId: senderId, ownerType: 'USER' } }
  });
  const finalReceiverWallet = await prisma.wallet.findUnique({
    where: { userId_ownerType: { userId: receiverId, ownerType: 'USER' } }
  });

  console.log(`   💰 Người gửi (${senderId}):`);
  console.log(`      - Tổng số dư: ${finalSenderWallet.balance} VND`);
  console.log(`      - Tiền tạm giữ (Held): ${finalSenderWallet.heldBalance} VND`);
  console.log(`      - Khả dụng: ${Number(finalSenderWallet.balance) - Number(finalSenderWallet.heldBalance)} VND`);

  console.log(`   💰 Người nhận (${receiverId}):`);
  console.log(`      - Tổng số dư: ${finalReceiverWallet.balance} VND`);
  console.log(`      - Tiền tạm giữ (Held): ${finalReceiverWallet.heldBalance} VND`);
  console.log(`      - Khả dụng: ${Number(finalReceiverWallet.balance) - Number(finalReceiverWallet.heldBalance)} VND`);

  console.log('\n🎉 HOÀN THÀNH TEST TOÀN BỘ LUỒNG CHUYỂN TIỀN P2P THÀNH CÔNG RỰC RỠ!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
