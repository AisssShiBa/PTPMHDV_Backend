import { PrismaClient, OwnerType, TransferType, HoldStatus } from '@prisma/client';
import { LedgerService } from '../src/services/ledger.service';
import { WalletHoldService } from '../src/services/wallet-hold.service';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();
const ledgerService = new LedgerService();
const holdService = new WalletHoldService(ledgerService);

async function runConcurrencyTest(): Promise<boolean> {
  console.log('--- TEST 1: RACE CONDITION (20 REQUEST CHUYỂN TIỀN SONG SONG) ---');
  
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
    data: { userId: userIdA, balance: 100000, currency: 'VND', ownerType: OwnerType.USER, kycTier: 1 }
  });

  // Tạo ví User B (0đ)
  const walletB = await prisma.wallet.create({
    data: { userId: userIdB, balance: 0, currency: 'VND', ownerType: OwnerType.USER, kycTier: 1 }
  });

  console.log(`Đã tạo ví A: ${walletA.balance}đ | Ví B: ${walletB.balance}đ`);
  console.log('Đang bắn 20 request đồng thời (mỗi request chuyển 60.000đ từ A sang B)...');

  // 2. Bắn 20 request song song
  const promises = [];
  for (let i = 0; i < 20; i++) {
    const p = ledgerService.transfer({
      fromUserId: userIdA,
      toUserId: userIdB,
      amount: '60000',
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
    return true;
  } else {
    console.log('❌ FAIL TEST 1: Hệ thống bị lọt lỗi Race Condition!');
    return false;
  }
}

async function runDeadlockTest(): Promise<boolean> {
  console.log('\n--- TEST 2: DEADLOCK (CHUYỂN TIỀN CHÉO CÙNG MỘT LÚC) ---');
  
  const userIdC = 'test_user_c_' + Date.now();
  const userIdD = 'test_user_d_' + Date.now();

  const walletC = await prisma.wallet.create({
    data: { userId: userIdC, balance: 500000, currency: 'VND', ownerType: OwnerType.USER, kycTier: 1 }
  });
  const walletD = await prisma.wallet.create({
    data: { userId: userIdD, balance: 500000, currency: 'VND', ownerType: OwnerType.USER, kycTier: 1 }
  });

  console.log(`Ví C: 500k | Ví D: 500k`);
  console.log('Mô phỏng: C chuyển cho D và D chuyển cho C CÙNG MỘT LÚC...');

  const promise1 = ledgerService.transfer({
    fromUserId: userIdC,
    toUserId: userIdD,
    amount: '100000',
    referenceId: randomUUID(),
    transferType: TransferType.P2P_TRANSFER
  }).then(() => 'C->D OK').catch(e => `C->D LỖI: ${e.message}`);

  const promise2 = ledgerService.transfer({
    fromUserId: userIdD,
    toUserId: userIdC,
    amount: '200000',
    referenceId: randomUUID(),
    transferType: TransferType.P2P_TRANSFER
  }).then(() => 'D->C OK').catch(e => `D->C LỖI: ${e.message}`);

  const [res1, res2] = await Promise.all([promise1, promise2]);
  console.log(`Kết quả chéo: [1] ${res1} | [2] ${res2}`);

  if (res1 === 'C->D OK' && res2 === 'D->C OK') {
    console.log('✅ PASS TEST 2: Không bị Deadlock. Cơ chế sắp xếp ID khóa (lockAndFetchWalletsTx) hoạt động hoàn hảo!');
    return true;
  } else {
    console.log('❌ FAIL TEST 2: Bị văng lỗi Deadlock (hoặc lỗi khác)!');
    return false;
  }
}

async function runParallelHoldTest(): Promise<boolean> {
  console.log('\n--- TEST 3: 2 REQUEST HOLD SONG SONG TRÊN CÙNG MỘT VÍ ---');
  
  const userIdE = 'test_user_hold_' + Date.now();

  // Tạo ví User E với số dư 100.000đ, heldBalance ban đầu = 0đ
  const walletE = await prisma.wallet.create({
    data: {
      userId: userIdE,
      balance: 100000,
      heldBalance: 0,
      currency: 'VND',
      ownerType: OwnerType.USER,
      kycTier: 1
    }
  });

  console.log(`Đã tạo ví E: Số dư = ${walletE.balance}đ, Số dư tạm giữ (heldBalance) = ${walletE.heldBalance}đ`);
  console.log('Bắn đồng thời 2 request hold (mỗi request giữ 60.000đ)...');

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const ref1 = randomUUID();
  const ref2 = randomUUID();

  interface HoldResult {
    success: boolean;
    req: string;
    error?: string;
  }

  const promise1 = holdService.createHold(userIdE, '60000', ref1, expiresAt)
    .then((): HoldResult => ({ success: true, req: 'HOLD_1' }))
    .catch((err): HoldResult => ({ success: false, req: 'HOLD_1', error: err.message }));

  const promise2 = holdService.createHold(userIdE, '60000', ref2, expiresAt)
    .then((): HoldResult => ({ success: true, req: 'HOLD_2' }))
    .catch((err): HoldResult => ({ success: false, req: 'HOLD_2', error: err.message }));

  const [res1, res2] = await Promise.all([promise1, promise2]);

  const successes = [res1, res2].filter(r => r.success).length;
  const failures = [res1, res2].filter(r => !r.success).length;

  console.log(`Kết quả hold: ${successes} THÀNH CÔNG, ${failures} THẤT BẠI.`);
  console.log(`Chi tiết: Req 1: ${res1.success ? 'OK' : res1.error} | Req 2: ${res2.success ? 'OK' : res2.error}`);

  const finalWalletE = await prisma.wallet.findUnique({ where: { id: walletE.id } });
  const finalBalance = Number(finalWalletE?.balance);
  const finalHeldBalance = Number(finalWalletE?.heldBalance);
  const availableBalance = finalBalance - finalHeldBalance;

  console.log(`Số dư ví E sau hold: balance = ${finalBalance}đ, heldBalance = ${finalHeldBalance}đ, khả dụng = ${availableBalance}đ`);

  const createdHolds = await prisma.walletHold.findMany({
    where: { sourceWalletId: walletE.id, status: HoldStatus.PENDING }
  });
  console.log(`Số bản ghi WalletHold ở trạng thái PENDING: ${createdHolds.length}`);

  // Kỳ vọng: Đúng 1 request thành công, 1 request thất bại do không đủ số dư khả dụng (40.000 < 60.000),
  // heldBalance tăng đúng 60.000đ và chỉ có đúng 1 bản ghi WalletHold PENDING được tạo.
  const isValidResult = successes === 1 &&
    failures === 1 &&
    finalHeldBalance === 60000 &&
    finalBalance === 100000 &&
    availableBalance === 40000 &&
    createdHolds.length === 1;

  if (isValidResult) {
    console.log('✅ PASS TEST 3: Database đã chặn thành công Race Condition khi hold song song trên cùng ví!');
    return true;
  } else {
    console.log('❌ FAIL TEST 3: Hold song song bị lỗi race condition hoặc số dư không chính xác!');
    return false;
  }
}

async function runAll() {
  let allPassed = false;
  try {
    const pass1 = await runConcurrencyTest();
    const pass2 = await runDeadlockTest();
    const pass3 = await runParallelHoldTest();
    allPassed = pass1 && pass2 && pass3;
  } catch (err) {
    console.error('Lỗi ngoại lệ khi chạy test concurrency:', err);
    allPassed = false;
  } finally {
    await prisma.$disconnect();
  }

  if (allPassed) {
    console.log('\n=============================================');
    console.log('🎉 TẤT CẢ TEST ĐỒNG THỜI (CONCURRENCY) ĐÃ PASS!');
    console.log('=============================================\n');
    process.exit(0);
  } else {
    console.error('\n=============================================');
    console.error('❌ MỘT HOẶC NHIỀU TEST CONCURRENCY BỊ THẤT BẠI!');
    console.error('=============================================\n');
    process.exit(1);
  }
}

runAll();
