/**
 * K16 Invariant Checker
 * Kiểm tra 2 bất biến tài chính cốt lõi:
 * 1. Tổng số dư toàn hệ thống (User + SYSTEM) bảo toàn (Conservation of Money):
 *    - Trong mỗi kịch bản/test: delta (sau - trước) = 0
 * 2. Tổng bút toán LedgerEntry: Nợ (DEBIT) = Có (CREDIT) (Double-entry Invariant)
 */

const path = require('path');
const { PrismaClient } = require(path.resolve(__dirname, '../services/wallet-service/node_modules/@prisma/client'));

const walletDbUrl = process.env.WALLET_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://postgres:8932ce4c6b28dba8c13430d3317b1e51e4f8838c6b02824423f9b57b69d56d4a@localhost:5432/wallet_service?schema=public';

async function getFinancialSnapshot(prismaClient) {
  const prisma = prismaClient || new PrismaClient({ datasources: { db: { url: walletDbUrl } } });
  const shouldDisconnect = !prismaClient;

  try {
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

    const debitEntries = await prisma.ledgerEntry.aggregate({
      where: { direction: 'DEBIT' },
      _sum: { amount: true },
      _count: true
    });
    const creditEntries = await prisma.ledgerEntry.aggregate({
      where: { direction: 'CREDIT' },
      _sum: { amount: true },
      _count: true
    });

    return {
      userBalance: Number(userWallets._sum.balance || 0),
      userHeld: Number(userWallets._sum.heldBalance || 0),
      systemBalance: Number(systemWallets._sum.balance || 0),
      systemHeld: Number(systemWallets._sum.heldBalance || 0),
      totalBalance: Number(totalWallets._sum.balance || 0),
      totalHeld: Number(totalWallets._sum.heldBalance || 0),
      totalDebit: Number(debitEntries._sum.amount || 0),
      totalCredit: Number(creditEntries._sum.amount || 0),
      debitCount: debitEntries._count,
      creditCount: creditEntries._count,
      timestamp: new Date().toISOString()
    };
  } finally {
    if (shouldDisconnect) {
      await prisma.$disconnect();
    }
  }
}

function verifyDeltaConservation(before, after) {
  const deltaTotalBalance = Math.round((after.totalBalance - before.totalBalance) * 100) / 100;
  const deltaCredit = Math.round((after.totalCredit - before.totalCredit) * 100) / 100;
  const deltaDebit = Math.round((after.totalDebit - before.totalDebit) * 100) / 100;
  const deltaCreditDebit = Math.round((deltaCredit - deltaDebit) * 100) / 100;

  const isBalanceConserved = Math.abs(deltaTotalBalance) < 0.01;
  const isLedgerBalanced = Math.abs(deltaCreditDebit) < 0.01;
  const passed = isBalanceConserved && isLedgerBalanced;

  console.log('=== K16 DELTA INVARIANT REPORT ===');
  console.log(`Thời gian:                    ${before.timestamp} -> ${after.timestamp}`);
  console.log(`Tổng số dư trước:             ${before.totalBalance.toLocaleString()} VND`);
  console.log(`Tổng số dư sau:               ${after.totalBalance.toLocaleString()} VND`);
  console.log(`Chênh lệch số dư (Delta):     ${deltaTotalBalance} VND -> ${isBalanceConserved ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);
  console.log(`Delta Bút toán CREDIT:        ${deltaCredit.toLocaleString()} VND`);
  console.log(`Delta Bút toán DEBIT:         ${deltaDebit.toLocaleString()} VND`);
  console.log(`Chênh lệch CREDIT - DEBIT:    ${deltaCreditDebit} VND -> ${isLedgerBalanced ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);
  console.log(`KẾT LUẬN:                     ${passed ? 'ĐẠT (PASS)' : 'KHÔNG ĐẠT (FAIL)'}`);
  console.log('==================================');

  return {
    passed,
    isBalanceConserved,
    isLedgerBalanced,
    deltaTotalBalance,
    deltaCredit,
    deltaDebit,
    deltaCreditDebit
  };
}

async function checkGlobalInvariants(prismaClient) {
  const snapshot = await getFinancialSnapshot(prismaClient);
  const deltaLedger = snapshot.totalCredit - snapshot.totalDebit;
  const isBalanceZero = Math.abs(snapshot.totalBalance) < 0.01;
  const isLedgerEqual = Math.abs(deltaLedger) < 0.01;

  console.log('=== K16 GLOBAL INVARIANT SNAPSHOT ===');
  console.log(`Thời điểm:                   ${snapshot.timestamp}`);
  console.log(`Tổng số dư User:             ${snapshot.userBalance.toLocaleString()} VND (Held: ${snapshot.userHeld.toLocaleString()})`);
  console.log(`Tổng số dư SYSTEM:           ${snapshot.systemBalance.toLocaleString()} VND (Held: ${snapshot.systemHeld.toLocaleString()})`);
  console.log(`Tổng số dư toàn hệ thống:    ${snapshot.totalBalance.toLocaleString()} VND`);
  console.log(`Bút toán DEBIT:              ${snapshot.totalDebit.toLocaleString()} VND (${snapshot.debitCount} entries)`);
  console.log(`Bút toán CREDIT:             ${snapshot.totalCredit.toLocaleString()} VND (${snapshot.creditCount} entries)`);
  console.log(`Chênh lệch CREDIT - DEBIT:   ${deltaLedger.toLocaleString()} VND`);
  console.log(`Số dư = 0:                   ${isBalanceZero ? 'ĐẠT' : 'CHÊNH LỆCH ' + snapshot.totalBalance}`);
  console.log(`Ledger Nợ = Có:              ${isLedgerEqual ? 'ĐẠT' : 'CHÊNH LỆCH ' + deltaLedger}`);
  console.log('=====================================');

  return snapshot;
}

if (require.main === module) {
  checkGlobalInvariants()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = {
  getFinancialSnapshot,
  verifyDeltaConservation,
  checkGlobalInvariants
};
