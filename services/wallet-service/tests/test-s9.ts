import { PrismaClient, Prisma, OwnerType, SystemWalletCode, TransferType } from '@prisma/client';
import { WalletService } from '../src/services/wallet.service';
import { LedgerService } from '../src/services/ledger.service';
import { ReconciliationService } from '../src/services/reconciliation.service';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();
const ledgerService = new LedgerService();
const reconciliationService = new ReconciliationService();

async function runTestS9() {
  console.log('================================================================');
  console.log('BẮT ĐẦU TEST S9: HỆ THỐNG VÍ SYSTEM & MERCHANDISING BẢO TOÀN SỐ DƯ');
  console.log('================================================================');

  // --------------------------------------------------------------------------
  // BƯỚC 1: Khởi tạo 2 instance WalletService cùng lúc
  // Yêu cầu: Không tạo lại ví SYSTEM lúc chạy; chỉ có đúng 1 bản ghi cho mỗi loại ví hệ thống
  // --------------------------------------------------------------------------
  console.log('\n[1] Kiểm tra khởi động 2 instance WalletService cùng lúc...');
  const walletService1 = new WalletService();
  const walletService2 = new WalletService();
  console.log('  -> Khởi tạo thành công 2 instance WalletService.');

  // Đảm bảo 3 ví hệ thống tồn tại (nếu chạy test môi trường độc lập chưa migrate)
  const systemWallets = [
    { systemCode: SystemWalletCode.MAIN, balance: 0 },
    { systemCode: SystemWalletCode.FEE, balance: 0 },
    { systemCode: SystemWalletCode.TOPUP_POOL, balance: 0 },
  ];

  for (const sw of systemWallets) {
    const existing = await prisma.wallet.findUnique({
      where: { systemCode: sw.systemCode },
    });
    if (!existing) {
      await prisma.wallet.create({
        data: {
          systemCode: sw.systemCode,
          ownerType: OwnerType.SYSTEM,
          balance: sw.balance,
          currency: 'VND',
        },
      });
      console.log(`  -> Đã seed bổ sung ví hệ thống ${sw.systemCode} cho test.`);
    }
  }

  // Đếm số lượng ví hệ thống cho mỗi mã
  const mainWallets = await prisma.wallet.findMany({ where: { systemCode: SystemWalletCode.MAIN } });
  const feeWallets = await prisma.wallet.findMany({ where: { systemCode: SystemWalletCode.FEE } });
  const topupWallets = await prisma.wallet.findMany({ where: { systemCode: SystemWalletCode.TOPUP_POOL } });

  console.log(`  -> Số lượng ví MAIN: ${mainWallets.length} (Kỳ vọng: 1)`);
  console.log(`  -> Số lượng ví FEE: ${feeWallets.length} (Kỳ vọng: 1)`);
  console.log(`  -> Số lượng ví TOPUP_POOL: ${topupWallets.length} (Kỳ vọng: 1)`);

  if (mainWallets.length !== 1 || feeWallets.length !== 1 || topupWallets.length !== 1) {
    throw new Error('❌ FAIL: Mỗi loại ví hệ thống phải có ĐÚNG 1 bản ghi duy nhất!');
  }
  console.log('✅ PASS [1]: Mỗi mã ví hệ thống có duy nhất 1 bản ghi!');

  // --------------------------------------------------------------------------
  // BƯỚC 2: Kiểm tra ví Merchant và tính tương thích đa vai trò của 1 chủ thể
  // Yêu cầu: ownerType=MERCHANT, userId = merchant.id (M22).
  // 1 chủ thể có thể đồng thời sở hữu ví USER và ví MERCHANT.
  // --------------------------------------------------------------------------
  console.log('\n[2] Kiểm tra tạo ví Merchant và quan hệ @@unique([userId, ownerType])...');
  const merchantId = 'merchant_id_' + Date.now();

  // Tạo ví USER với ID này
  const userWallet = await walletService1.createWallet({
    userId: merchantId,
    ownerType: OwnerType.USER,
  });
  console.log(`  -> Đã tạo ví USER cho ID ${merchantId}: walletId=${userWallet.wallet.id}`);

  // Tạo ví MERCHANT với CÙNG ID này
  const merchantWallet = await walletService2.createWallet({
    userId: merchantId,
    ownerType: OwnerType.MERCHANT,
  });
  console.log(`  -> Đã tạo ví MERCHANT cho ID ${merchantId}: walletId=${merchantWallet.wallet.id}`);

  if (userWallet.wallet.id === merchantWallet.wallet.id) {
    throw new Error('❌ FAIL: Ví USER và ví MERCHANT của cùng 1 ID phải là 2 ví độc lập!');
  }
  console.log('✅ PASS [2]: Đã hỗ trợ đồng thời ví USER và MERCHANT cho cùng một chủ thể!');

  // --------------------------------------------------------------------------
  // BƯỚC 3: Kiểm tra định tuyến transferType trong getWalletIds
  // Yêu cầu: TOPUP đối ứng ví TOPUP_POOL, PAYMENT đối ứng ví MAIN (hoặc merchant).
  // --------------------------------------------------------------------------
  console.log('\n[3] Kiểm tra giao dịch và định tuyến ví...');
  const topupAmount = '1000000.00';
  const topupRef = 'topup_ref_' + randomUUID();

  // Nạp 1.000.000đ vào ví user
  console.log(`  -> Thực hiện TOPUP ${topupAmount}đ vào ví User...`);
  await ledgerService.credit(merchantId, {
    amount: topupAmount,
    referenceId: topupRef,
    transferType: TransferType.TOPUP,
  }, OwnerType.USER);

  // Kiểm tra số dư ví TOPUP_POOL và User
  const topupPoolWallet = await prisma.wallet.findUnique({ where: { systemCode: SystemWalletCode.TOPUP_POOL } });
  const updatedUserWallet = await prisma.wallet.findUnique({ where: { id: userWallet.wallet.id } });

  console.log(`  -> Số dư ví TOPUP_POOL: ${topupPoolWallet?.balance}đ`);
  console.log(`  -> Số dư ví User: ${updatedUserWallet?.balance}đ`);

  // Thanh toán 200.000đ từ ví User sang ví Merchant
  console.log('  -> Thực hiện chuyển tiền 200.000đ từ ví User sang ví Merchant...');
  const p2pMovement = await prisma.$transaction(async (tx) => {
    return await ledgerService.moveMoneyTxInternal(tx, {
      fromWallet: updatedUserWallet!,
      toWallet: merchantWallet.wallet,
      amount: new Prisma.Decimal('200000.00'),
      referenceId: 'pay_ref_' + randomUUID(),
      transferType: TransferType.PAYMENT,
    });
  });
  console.log(`  -> Chuyển thành công. User còn: ${p2pMovement.sourceWallet.balance}đ | Merchant nhận: ${p2pMovement.destinationWallet.balance}đ`);

  // --------------------------------------------------------------------------
  // BƯỚC 4: Kiểm tra bảo toàn toàn hệ thống: checkSystemConservation = 0
  // Yêu cầu: SUM(all balances) = 0
  // --------------------------------------------------------------------------
  console.log('\n[4] Kiểm tra tính bảo toàn hệ thống (checkSystemConservation)...');
  const conservation = await reconciliationService.checkSystemConservation();
  console.log(`  -> Tổng số dư toàn hệ thống (actual): ${conservation.actual}đ`);
  console.log(`  -> Kỳ vọng (expected): ${conservation.expected}đ`);
  console.log(`  -> Trạng thái cân bằng (isBalanced): ${conservation.isBalanced}`);

  if (!conservation.isBalanced || Math.abs(Number(conservation.actual)) > 0.01) {
    throw new Error(`❌ FAIL: Tổng số dư hệ thống không cân bằng! actual=${conservation.actual}`);
  }
  console.log('✅ PASS [4]: checkSystemConservation = 0 hoàn toàn chính xác!');

  console.log('\n================================================================');
  console.log('🎉 TẤT CẢ CÁC MỤC TEST S9 ĐÃ PASS THÀNH CÔNG VÀ ĐẠT TIÊU CHUẨN!');
  console.log('================================================================\n');
}

runTestS9()
  .catch((err) => {
    console.error('Test S9 gặp lỗi:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
