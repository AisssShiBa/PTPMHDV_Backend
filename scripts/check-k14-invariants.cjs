const path = require('path');
const { PrismaClient } = require(path.resolve(__dirname, '../services/wallet-service/node_modules/@prisma/client'));

const walletDbUrl = process.env.WALLET_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://postgres:8932ce4c6b28dba8c13430d3317b1e51e4f8838c6b02824423f9b57b69d56d4a@localhost:5432/wallet_service?schema=public';

async function getSnapshot(prisma) {
  const userWallets = await prisma.wallet.aggregate({
    where: { ownerType: 'USER' },
    _sum: { balance: true, heldBalance: true }
  });
  const systemWallets = await prisma.wallet.aggregate({
    where: { ownerType: 'SYSTEM' },
    _sum: { balance: true, heldBalance: true }
  });
  const totalWallets = await prisma.wallet.aggregate({
    _sum: { balance: true, heldBalance: true }
  });
  const ledgerCount = await prisma.ledgerEntry.count();
  const ledgerSum = await prisma.ledgerEntry.aggregate({
    _sum: { amount: true }
  });

  return {
    userBalance: Number(userWallets._sum.balance || 0),
    userHeld: Number(userWallets._sum.heldBalance || 0),
    systemBalance: Number(systemWallets._sum.balance || 0),
    systemHeld: Number(systemWallets._sum.heldBalance || 0),
    totalBalance: Number(totalWallets._sum.balance || 0),
    totalHeld: Number(totalWallets._sum.heldBalance || 0),
    ledgerCount,
    ledgerSum: Number(ledgerSum._sum.amount || 0),
    timestamp: new Date().toISOString()
  };
}

function compareSnapshots(before, after) {
  const deltaBalance = after.totalBalance - before.totalBalance;
  const deltaLedgerCount = after.ledgerCount - before.ledgerCount;
  const deltaLedgerSum = after.ledgerSum - before.ledgerSum;

  const passed = deltaBalance === 0 && deltaLedgerCount === 0;

  console.log('=== K14 INVARIANT CHECK REPORT ===');
  console.log(`Thời điểm Trước: ${before.timestamp}`);
  console.log(`Thời điểm Sau:   ${after.timestamp}`);
  console.log(`Tổng số dư (User + SYSTEM) trước: ${before.totalBalance} VND`);
  console.log(`Tổng số dư (User + SYSTEM) sau:   ${after.totalBalance} VND`);
  console.log(`Chênh lệch số dư (Delta):         ${deltaBalance} VND`);
  console.log(`Số LedgerEntry trước:             ${before.ledgerCount}`);
  console.log(`Số LedgerEntry sau:               ${after.ledgerCount}`);
  console.log(`Chênh lệch LedgerEntry (Delta):   ${deltaLedgerCount}`);
  console.log(`Chênh lệch LedgerSum:             ${deltaLedgerSum}`);
  console.log(`Kết quả kiểm tra bất biến:        ${passed ? 'ĐẠT (PASS)' : 'KHÔNG ĐẠT (FAIL)'}`);
  console.log('==================================');

  return {
    passed,
    deltaBalance,
    deltaLedgerCount,
    deltaLedgerSum
  };
}

async function runStandalone() {
  const prisma = new PrismaClient({
    datasources: { db: { url: walletDbUrl } }
  });

  try {
    console.log('--- Đang quét và kiểm tra bất biến trên cơ sở dữ liệu wallet_service ---');
    const snapshot = await getSnapshot(prisma);

    // Kiểm tra tính toàn vẹn cơ sở dữ liệu hiện tại
    const negativeHeldWallets = await prisma.wallet.findMany({
      where: { heldBalance: { lt: 0 } },
      select: { id: true, userId: true, ownerType: true, heldBalance: true }
    });
    const negativeBalanceWallets = await prisma.wallet.findMany({
      where: { ownerType: 'USER', balance: { lt: 0 } },
      select: { id: true, userId: true, balance: true }
    });
    const negativeUsage = await prisma.userDailyUsage.findMany({
      where: { spentDay: { lt: 0 } },
      select: { id: true, userId: true, spentDay: true }
    });

    console.log(`1. Tổng số dư toàn hệ thống: ${snapshot.totalBalance} VND (USER: ${snapshot.userBalance}, SYSTEM: ${snapshot.systemBalance})`);
    console.log(`2. Tổng heldBalance đang giữ: ${snapshot.totalHeld} VND (USER: ${snapshot.userHeld}, SYSTEM: ${snapshot.systemHeld})`);
    console.log(`3. Tổng số bút toán LedgerEntry: ${snapshot.ledgerCount} (Tổng giá trị amount: ${snapshot.ledgerSum})`);
    console.log(`4. Số ví bị âm heldBalance: ${negativeHeldWallets.length}`);
    console.log(`5. Số ví USER bị âm balance: ${negativeBalanceWallets.length}`);
    console.log(`6. Số bản ghi hạn mức bị âm spentDay: ${negativeUsage.length}`);

    const isHealthy = negativeHeldWallets.length === 0 &&
      negativeBalanceWallets.length === 0 &&
      negativeUsage.length === 0;

    console.log(`\nKết quả kiểm tra DB: ${isHealthy ? 'ĐẠT (HỆ THỐNG AN TOÀN VÀ BẢO TOÀN)' : 'KHÔNG ĐẠT (PHÁT HIỆN SỐ LIỆU ÂM)'}`);
    if (!isHealthy) {
      if (negativeHeldWallets.length > 0) console.error('Chi tiết ví âm heldBalance:', negativeHeldWallets);
      if (negativeBalanceWallets.length > 0) console.error('Chi tiết ví âm balance:', negativeBalanceWallets);
      if (negativeUsage.length > 0) console.error('Chi tiết hạn mức âm spentDay:', negativeUsage);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('Lỗi khi chạy kiểm tra bất biến:', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  runStandalone();
}

module.exports = {
  getSnapshot,
  compareSnapshots,
  runStandalone
};
