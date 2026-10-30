import { PaymentService } from '../src/services/payment.service';
import { WalletClient } from '../src/clients/wallet.client';
import { DomainException } from '../src/utils/domain.exception';

async function runTests() {
  console.log('🧪 BẮT ĐẦU TEST LOGIC P2P QUOTE...\n');

  // Giả lập (Mock) WalletClient
  const mockWalletClient = {
    getBalance: async (userId: string) => {
      if (userId === 'user-sender') {
        return { balance: '500000', heldBalance: '100000', availableBalance: '400000' };
      }
      if (userId === 'user-receiver') {
        return { balance: '200000', heldBalance: '0', availableBalance: '200000' };
      }
      // Người dùng không tồn tại
      return null;
    }
  } as unknown as WalletClient;

  const paymentService = new PaymentService(mockWalletClient);

  // Test Case 1: Tự chuyển tiền cho chính mình
  try {
    await paymentService.p2pQuote('user-sender', 'user-sender', '50000');
    console.error('❌ Test 1 FAILED: Không chặn tự chuyển tiền cho chính mình');
  } catch (err: any) {
    if (err instanceof DomainException && err.code === 'SELF_TRANSFER_NOT_ALLOWED') {
      console.log('✅ Test 1 PASSED: Chặn tự chuyển cho chính mình (SELF_TRANSFER_NOT_ALLOWED)');
    } else {
      console.error('❌ Test 1 FAILED với lỗi không mong muốn:', err);
    }
  }

  // Test Case 2: Người nhận không tồn tại hoặc chưa có ví
  try {
    await paymentService.p2pQuote('user-sender', 'user-unknown', '50000');
    console.error('❌ Test 2 FAILED: Không chặn người nhận không tồn tại');
  } catch (err: any) {
    if (err instanceof DomainException && err.code === 'DESTINATION_WALLET_NOT_FOUND') {
      console.log('✅ Test 2 PASSED: Báo lỗi người nhận chưa có ví (DESTINATION_WALLET_NOT_FOUND)');
    } else {
      console.error('❌ Test 2 FAILED với lỗi không mong muốn:', err);
    }
  }

  // Test Case 3: Người gửi không đủ số dư khả dụng (Ví có 400k khả dụng nhưng chuyển 600k)
  try {
    await paymentService.p2pQuote('user-sender', 'user-receiver', '600000');
    console.error('❌ Test 3 FAILED: Không chặn khi số dư không đủ');
  } catch (err: any) {
    if (err instanceof DomainException && err.code === 'INSUFFICIENT_FUNDS') {
      console.log('✅ Test 3 PASSED: Báo lỗi không đủ số dư khả dụng (INSUFFICIENT_FUNDS)');
    } else {
      console.error('❌ Test 3 FAILED với lỗi không mong muốn:', err);
    }
  }

  // Test Case 4: Chuyển tiền hợp lệ (Ví có 400k khả dụng, chuyển 100k)
  try {
    const result = await paymentService.p2pQuote('user-sender', 'user-receiver', '100000');
    console.log('✅ Test 4 PASSED: Tạo báo giá thành công!');
    console.log('📦 Dữ liệu trả về:', JSON.stringify(result, null, 2));

    const expiresAtMs = new Date(result.expiresAt).getTime();
    const nowMs = Date.now();
    const diffSec = Math.round((expiresAtMs - nowMs) / 1000);
    console.log(`⏱️ Thời hạn báo giá: ${diffSec} giây (chuẩn ~60s)`);
    console.log(`💰 Phí giao dịch: ${result.fee}đ`);
  } catch (err: any) {
    console.error('❌ Test 4 FAILED:', err);
  }

  console.log('\n🎉 TẤT CẢ TEST CASES ĐÃ HOÀN TẤT!');
}

runTests();
