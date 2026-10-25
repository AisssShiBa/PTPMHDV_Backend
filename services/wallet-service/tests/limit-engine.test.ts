import { PrismaClient, OwnerType, HoldStatus, TransferType } from '@prisma/client';
import { randomUUID } from 'crypto';
import assert from 'assert';
import { LedgerService } from '../src/services/ledger.service';
import { WalletHoldService } from '../src/services/wallet-hold.service';
import { LimitService } from '../src/services/limit.service';
import { DomainException } from '../src/utils/domain.exception';
import { getVnDay, getVnMonthKey } from '../src/utils/timezone.helper';
import { seedLimitPolicies } from '../prisma/seed';

const prisma = new PrismaClient();
const ledgerService = new LedgerService();
const limitService = new LimitService();
const holdService = new WalletHoldService(ledgerService, limitService);

async function runAllTests() {
  console.log('==================================================');
  console.log('🧪 BẮT ĐẦU TEST TOÀN BỘ K8 LIMIT ENGINE');
  console.log('==================================================');

  // Đảm bảo seed LimitPolicy tồn tại
  await seedLimitPolicies();

  // Helper tạo user và ví
  async function createTestWallet(balance: number, kycTier = 0) {
    const userId = 'user_' + randomUUID().slice(0, 8);
    const wallet = await prisma.wallet.create({
      data: {
        userId,
        balance,
        heldBalance: 0,
        currency: 'VND',
        ownerType: OwnerType.USER,
        kycTier,
      },
    });
    return { userId, wallet };
  }

  // Tạo ví đích
  const dest = await createTestWallet(0, 0);

  // ----------------------------------------------------
  // TEST 1: Vượt hạn mức ngày (đã chi 450k, hold thêm 100k -> 422 PER_DAY, remaining=50k)
  // ----------------------------------------------------
  console.log('\n--- Test 1: Vượt hạn mức ngày (450k + 100k > 500k) ---');
  {
    const sender = await createTestWallet(1000000, 0); // Cấp 0: perDay = 500k
    const expiry = new Date(Date.now() + 60000).toISOString();

    // Thực hiện 3 lần hold 150.000đ (tổng = 450.000đ, mỗi lần <= perTxn 200.000đ)
    for (let i = 1; i <= 3; i++) {
      const holdRes = await holdService.createHold(
        sender.userId,
        '150000',
        `ref_init_${i}_` + randomUUID(),
        expiry,
        OwnerType.USER,
        dest.userId
      );
      assert.strictEqual(holdRes.hold.status, HoldStatus.PENDING);
    }

    // Hold 2: 100.000đ (phải ném 422 LIMIT_EXCEEDED với limitType = PER_DAY)
    let caught: DomainException | null = null;
    try {
      await holdService.createHold(
        sender.userId,
        '100000',
        'ref_' + randomUUID(),
        expiry,
        OwnerType.USER,
        dest.userId
      );
    } catch (err: any) {
      caught = err;
    }

    assert.ok(caught, 'Phải ném lỗi khi vượt hạn mức ngày');
    assert.strictEqual(caught.status, 422);
    assert.strictEqual(caught.code, 'LIMIT_EXCEEDED');
    assert.strictEqual(caught.details?.limitType, 'PER_DAY');
    assert.strictEqual(caught.details?.limit, '500000.00');
    assert.strictEqual(caught.details?.used, '450000.00');
    assert.strictEqual(caught.details?.remaining, '50000.00');
    console.log('✅ PASS Test 1: Đã chi 450k, hold thêm 100k bị từ chối chính xác remaining = 50k');
  }

  // ----------------------------------------------------
  // TEST 2: PER_TXN (Cấp 0: perTxn = 200k, hold 200.001đ -> từ chối PER_TXN)
  // ----------------------------------------------------
  console.log('\n--- Test 2: Vượt hạn mức lần (200.001 > 200.000) ---');
  {
    const sender = await createTestWallet(1000000, 0);
    const expiry = new Date(Date.now() + 60000).toISOString();

    let caught: DomainException | null = null;
    try {
      await holdService.createHold(
        sender.userId,
        '200001',
        'ref_' + randomUUID(),
        expiry,
        OwnerType.USER,
        dest.userId
      );
    } catch (err: any) {
      caught = err;
    }

    assert.ok(caught);
    assert.strictEqual(caught.status, 422);
    assert.strictEqual(caught.details?.limitType, 'PER_TXN');
    assert.strictEqual(caught.details?.limit, '200000.00');
    console.log('✅ PASS Test 2: Chuyển 200.001đ bị từ chối PER_TXN');
  }

  // ----------------------------------------------------
  // TEST 3: Hạn mức tháng (chi nhiều ngày trong cùng tháng, vượt 2.000.000 -> PER_MONTH)
  // ----------------------------------------------------
  console.log('\n--- Test 3: Hạn mức tháng (tổng các ngày > 2.000.000) ---');
  {
    const sender = await createTestWallet(5000000, 0); // Cấp 0: perMonth = 2.000.000
    const today = new Date();
    const monthKey = getVnMonthKey(today);

    // Giả lập 4 ngày trước trong tháng, mỗi ngày đã chi 450.000 (tổng = 1.800.000đ)
    for (let dayOffset = 1; dayOffset <= 4; dayOffset++) {
      const pastDay = `${monthKey}-${String(dayOffset).padStart(2, '0')}`;
      await prisma.userDailyUsage.create({
        data: {
          userId: sender.userId,
          day: pastDay,
          monthKey,
          spentDay: 450000,
        },
      });
    }

    const expiry = new Date(Date.now() + 60000).toISOString();

    // Hold 1: 150.000đ hôm nay (tổng tháng = 1.800.000 + 150.000 = 1.950.000 <= 2.000.000 -> THÀNH CÔNG)
    await holdService.createHold(
      sender.userId,
      '150000',
      'ref_' + randomUUID(),
      expiry,
      OwnerType.USER,
      dest.userId
    );

    // Hold 2: 100.000đ hôm nay (tổng tháng = 1.950.000 + 100.000 = 2.050.000 > 2.000.000 -> BỊ CHẶN BỞI PER_MONTH)
    let caught: DomainException | null = null;
    try {
      await holdService.createHold(
        sender.userId,
        '100000',
        'ref_' + randomUUID(),
        expiry,
        OwnerType.USER,
        dest.userId
      );
    } catch (err: any) {
      caught = err;
    }

    assert.ok(caught);
    assert.strictEqual(caught.status, 422);
    assert.strictEqual(caught.details?.limitType, 'PER_MONTH');
    assert.strictEqual(caught.details?.limit, '2000000.00');
    assert.strictEqual(caught.details?.used, '1950000.00');
    assert.strictEqual(caught.details?.remaining, '50000.00');
    console.log('✅ PASS Test 3: Vượt hạn mức tháng bị chặn chính xác với remaining = 50k');
  }

  // ----------------------------------------------------
  // TEST 4: Sang tháng mới (usage tháng cũ không ảnh hưởng tháng mới)
  // ----------------------------------------------------
  console.log('\n--- Test 4: Sang tháng mới không tính usage tháng cũ ---');
  {
    const sender = await createTestWallet(5000000, 0);
    // Giả lập tháng trước đã tiêu kịch kim 2.000.000đ
    await prisma.userDailyUsage.create({
      data: {
        userId: sender.userId,
        day: '2025-01-15',
        monthKey: '2025-01',
        spentDay: 2000000,
      },
    });

    const expiry = new Date(Date.now() + 60000).toISOString();
    // Hôm nay (tháng hiện tại) hold 200.000đ vẫn phải thành công
    const result = await holdService.createHold(
      sender.userId,
      '200000',
      'ref_' + randomUUID(),
      expiry,
      OwnerType.USER,
      dest.userId
    );
    assert.strictEqual(result.hold.status, HoldStatus.PENDING);
    console.log('✅ PASS Test 4: Sang tháng mới hạn mức reset hoàn toàn');
  }

  // ----------------------------------------------------
  // TEST 5: S6 Concurrency - 10 request song song ĐẦU NGÀY (chưa có row UserDailyUsage)
  // ----------------------------------------------------
  console.log('\n--- Test 5: S6 Concurrency - 10 request song song ĐẦU NGÀY ---');
  {
    const sender = await createTestWallet(5000000, 0); // Cấp 0: perDay = 500k, perTxn = 200k
    const expiry = new Date(Date.now() + 60000).toISOString();

    // Bắn 10 request song song, mỗi request 100.000đ.
    // Với perDay = 500.000đ, chỉ đúng 5 request được thành công, 5 request còn lại phải bị từ chối 422!
    const promises = Array.from({ length: 10 }, (_, i) =>
      holdService.createHold(
        sender.userId,
        '100000',
        `ref_concurrency_${i}_${randomUUID()}`,
        expiry,
        OwnerType.USER,
        dest.userId
      )
        .then(() => 'SUCCESS')
        .catch((e: any) => {
          console.error(`Request ${i} error:`, e.code, e.message);
          return `FAILED_${e.details?.limitType || e.code || e.message}`;
        })
    );

    const results = await Promise.all(promises);
    console.log('Chi tiết kết quả 10 requests:', results);
    const successes = results.filter((r) => r === 'SUCCESS').length;
    const failures = results.filter((r) => r.startsWith('FAILED')).length;

    console.log(`Kết quả Concurrency: ${successes} SUCCESS, ${failures} FAILED`);
    assert.strictEqual(successes, 5, `Phải có đúng 5 giao dịch thành công (đạt 500k), thực tế: ${successes}`);
    assert.strictEqual(failures, 5, `Phải có đúng 5 giao dịch bị chặn, thực tế: ${failures}`);

    const vnDay = getVnDay();
    const finalUsage = await prisma.userDailyUsage.findUnique({
      where: { userId_day: { userId: sender.userId, day: vnDay } },
    });
    assert.strictEqual(Number(finalUsage?.spentDay), 500000, 'spentDay cuối ngày phải đúng bằng 500.000');
    console.log('✅ PASS Test 5: S6 Concurrency hoàn hảo, không bị race condition ở đầu ngày');
  }

  // ----------------------------------------------------
  // TEST 6: S7 - Hoàn hạn mức khi Release và khi Hold hết hạn (kèm usageDay)
  // ----------------------------------------------------
  console.log('\n--- Test 6: S7 - Hoàn hạn mức khi Release và Expire ---');
  {
    const sender = await createTestWallet(1000000, 0);
    const expiry = new Date(Date.now() + 60000).toISOString();

    const ref = 'ref_release_' + randomUUID();
    const { hold } = await holdService.createHold(
      sender.userId,
      '150000',
      ref,
      expiry,
      OwnerType.USER,
      dest.userId
    );

    const vnDay = getVnDay();
    let usage = await prisma.userDailyUsage.findUnique({
      where: { userId_day: { userId: sender.userId, day: vnDay } },
    });
    assert.strictEqual(Number(usage?.spentDay), 150000);

    // Release hold
    await holdService.releaseHold(sender.userId, ref, OwnerType.USER);

    usage = await prisma.userDailyUsage.findUnique({
      where: { userId_day: { userId: sender.userId, day: vnDay } },
    });
    assert.strictEqual(Number(usage?.spentDay), 0, 'Sau khi release, spentDay phải hoàn về 0');
    console.log('✅ PASS Test 6: Release hold hoàn hạn mức về đúng row usageDay');
  }

  // ----------------------------------------------------
  // TEST 7: Double Refund - release và cron cùng chạy trên 1 hold, usage chỉ hoàn 1 lần
  // ----------------------------------------------------
  console.log('\n--- Test 7: Double Refund Idempotency ---');
  {
    const sender = await createTestWallet(1000000, 0);
    // Tạo hold đã hết hạn
    const expiredTime = new Date(Date.now() - 1000).toISOString();
    const ref = 'ref_double_refund_' + randomUUID();

    // Để tạo được hold quá hạn cho test, tạm tạo trước với expiresAt hợp lệ rồi update về quá khứ
    const validExpiry = new Date(Date.now() + 60000).toISOString();
    const { hold } = await holdService.createHold(
      sender.userId,
      '180000',
      ref,
      validExpiry,
      OwnerType.USER,
      dest.userId
    );

    await prisma.walletHold.update({
      where: { id: hold.id },
      data: { expiresAt: new Date(Date.now() - 5000) },
    });

    const vnDay = getVnDay();
    let usageBefore = await prisma.userDailyUsage.findUnique({
      where: { userId_day: { userId: sender.userId, day: vnDay } },
    });
    assert.strictEqual(Number(usageBefore?.spentDay), 180000);

    // Gọi đồng thời releaseHold VÀ releaseExpiredHolds
    await Promise.all([
      holdService.releaseHold(sender.userId, ref, OwnerType.USER),
      holdService.releaseExpiredHolds(),
      holdService.releaseExpiredHolds(),
    ]);

    const usageAfter = await prisma.userDailyUsage.findUnique({
      where: { userId_day: { userId: sender.userId, day: vnDay } },
    });
    assert.strictEqual(Number(usageAfter?.spentDay), 0, 'Usage chỉ hoàn đúng 1 lần (180k - 180k = 0), không bị âm');
    console.log('✅ PASS Test 7: Double refund chống hoàn 2 lần thành công');
  }

  // ----------------------------------------------------
  // TEST 8: Hạn mức không bị trừ khi INSUFFICIENT_BALANCE (Rollback đúng)
  // ----------------------------------------------------
  console.log('\n--- Test 8: Rollback đúng khi số dư không đủ ---');
  {
    const sender = await createTestWallet(50000, 0); // Chỉ có 50k trong ví
    const expiry = new Date(Date.now() + 60000).toISOString();

    let caught: any = null;
    try {
      // Chuyển 100.000đ: Hạn mức ngày còn đủ (100k < 500k), nhưng số dư chỉ có 50k
      await holdService.createHold(
        sender.userId,
        '100000',
        'ref_rollback_' + randomUUID(),
        expiry,
        OwnerType.USER,
        dest.userId
      );
    } catch (e) {
      caught = e;
    }

    assert.ok(caught);
    assert.strictEqual(caught.code, 'INSUFFICIENT_BALANCE');

    // Kiểm tra xem usage có bị trừ nhầm không
    const vnDay = getVnDay();
    const usage = await prisma.userDailyUsage.findUnique({
      where: { userId_day: { userId: sender.userId, day: vnDay } },
    });
    assert.strictEqual(Number(usage?.spentDay || 0), 0, 'Usage không được phép tăng khi transaction rollback');
    console.log('✅ PASS Test 8: Hạn mức không bị trừ khi INSUFFICIENT_BALANCE');
  }

  // ----------------------------------------------------
  // TEST 9: Direct P2P transfer cũng phải tuân thủ hạn mức
  // ----------------------------------------------------
  console.log('\n--- Test 9: Direct P2P transfer tuân thủ Limit Policy ---');
  {
    const sender = await createTestWallet(1000000, 0);
    // Chuyển 250.000đ (vượt perTxn 200.000đ của cấp 0)
    let caught: any = null;
    try {
      await ledgerService.transfer({
        fromUserId: sender.userId,
        toUserId: dest.userId,
        amount: '250000',
        referenceId: 'ref_direct_' + randomUUID(),
        transferType: TransferType.P2P_TRANSFER,
      });
    } catch (e) {
      caught = e;
    }

    assert.ok(caught);
    assert.strictEqual(caught.status, 422);
    assert.strictEqual(caught.details?.limitType, 'PER_TXN');
    console.log('✅ PASS Test 9: Direct P2P transfer bị chặn bởi Limit Policy');
  }

  console.log('\n==================================================');
  console.log('🎉 TẤT CẢ TEST CASES CỦA LIMIT ENGINE ĐÃ VƯỢT QUA!');
  console.log('==================================================');
}

runAllTests()
  .catch((err) => {
    console.error('❌ TEST FAILED:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
