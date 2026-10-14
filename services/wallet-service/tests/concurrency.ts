import { PrismaClient, OwnerType, TransferType } from '@prisma/client';
import { LedgerService } from '../src/services/ledger.service';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();
const ledgerService = new LedgerService();

async function runConcurrencyTest() {
  console.log('--- BẮT ĐẦU TEST LỖI TƯƠNG TRANH (RACE CONDITION) ---');
  
  // 1. Setup dữ liệu
  const userIdA = 'test_user_a_' + Date.now();
  const userIdB = 'test_user_b_' + Date.now();
  
  // Tạo ví System nếu chưa có
  let systemWallet = await prisma.wallet.findFirst({ where: { ownerType: OwnerType.SYSTEM } });
  if (!systemWallet) {
    systemWallet = await prisma.wallet.create({
      data: { balance: 1000000000, currency: 'VND', ownerType: OwnerType.SYSTEM }
    });
  }

  // Tạo ví User A (100.000đ)
  const walletA = await prisma.wallet.create({
    data: { userId: userIdA, balance: 100000, currency: 'VND', ownerType: OwnerType.USER }
  });

  // Tạo ví User B (0đ)
  const walletB = await prisma.wallet.create({
    data: { userId: userIdB, balance: 0, currency: 'VND', ownerType: OwnerType.USER }
  });

  console.log(`Đã tạo ví A: ${walletA.balance}đ | Ví B: ${walletB.balance}đ`);
  console.log('Đang bắn 20 request đồng thời (mỗi request chuyển 60.000đ từ A sang B)...');

  // 2. Bắn 20 request song song
  const promises = [];
  for (let i = 0; i < 20; i++) {
    const p = ledgerService.transfer({
      fromUserId: userIdA,
      toUserId: userIdB,
      amount: 60000,
      referenceId: randomUUID(),
      transferType: TransferType.P2P_TRANSFER
    }).then(() => 'SUCCESS').catch((err) => `FAILED: ${err.message}`);
    promises.push(p);
  }

  const results = await Promise.all(promises);
  
  const successes = results.filter(r => r === 'SUCCESS').length;
  const failures = results.filter(r => r !== 'SUCCESS').length;

  console.log(`Kết quả: ${successes} THÀNH CÔNG, ${failures} THẤT BẠI.`);
  
  const finalWalletA = await prisma.wallet.findUnique({ where: { id: walletA.id } });
  console.log(`Số dư cuối cùng ví A: ${finalWalletA?.balance}đ`);

  if (successes === 1 && Number(finalWalletA?.balance) === 40000) {
    console.log('✅ PASS TEST 1: Database đã Block thành công Race Condition!');
  } else {
    console.log('❌ FAIL TEST 1: Hệ thống bị lọt lỗi Race Condition!');
  }
}

async function runDeadlockTest() {
  console.log('\n--- BẮT ĐẦU TEST DEADLOCK (TẮC NGHẼN K2) ---');
  
  const userIdC = 'test_user_c_' + Date.now();
  const userIdD = 'test_user_d_' + Date.now();

  const walletC = await prisma.wallet.create({
    data: { userId: userIdC, balance: 500000, currency: 'VND', ownerType: OwnerType.USER }
  });
  const walletD = await prisma.wallet.create({
    data: { userId: userIdD, balance: 500000, currency: 'VND', ownerType: OwnerType.USER }
  });

  console.log(`Ví C: 500k | Ví D: 500k`);
  console.log('Mô phỏng: C chuyển cho D và D chuyển cho C CÙNG MỘT LÚC...');

  const promise1 = ledgerService.transfer({
    fromUserId: userIdC,
    toUserId: userIdD,
    amount: 100000,
    referenceId: randomUUID(),
    transferType: TransferType.P2P_TRANSFER
  }).then(() => 'C->D OK').catch(e => `C->D LỖI: ${e.message}`);

  const promise2 = ledgerService.transfer({
    fromUserId: userIdD,
    toUserId: userIdC,
    amount: 200000,
    referenceId: randomUUID(),
    transferType: TransferType.P2P_TRANSFER
  }).then(() => 'D->C OK').catch(e => `D->C LỖI: ${e.message}`);

  const [res1, res2] = await Promise.all([promise1, promise2]);
  console.log(`Kết quả chéo: [1] ${res1} | [2] ${res2}`);

  if (res1 === 'C->D OK' && res2 === 'D->C OK') {
    console.log('✅ PASS TEST 2: Không bị Deadlock. Cơ chế sắp xếp ID khóa (lockAndFetchWalletsTx) hoạt động hoàn hảo!');
  } else {
    console.log('❌ FAIL TEST 2: Bị văng lỗi Deadlock (hoặc lỗi khác)!');
  }
}

async function runAll() {
  try {
    await runConcurrencyTest();
    await runDeadlockTest();
  } catch (err) {
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}

runAll();
