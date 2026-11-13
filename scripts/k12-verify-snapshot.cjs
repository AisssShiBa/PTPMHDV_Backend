const path = require('path');
const { PrismaClient } = require(path.resolve(__dirname, '../services/wallet-service/node_modules/@prisma/client'));

const dbUrl = process.env.COPY_DB_URL || 'postgresql://postgres:8932ce4c6b28dba8c13430d3317b1e51e4f8838c6b02824423f9b57b69d56d4a@localhost:5432/wallet_db_k12_copy?schema=public';

const prisma = new PrismaClient({
  datasources: { db: { url: dbUrl } }
});

async function getSnapshot(label = 'SNAPSHOT') {
  console.log(`\n================== ${label} ==================`);
  
  // 1. Reconciliation: 4 loai
  // a. NEGATIVE_BALANCE
  const negBalance = await prisma.$queryRaw`
    SELECT id, "userId", balance, "ownerType" FROM "Wallet"
    WHERE balance < 0 AND "ownerType" != 'SYSTEM';
  `;
  
  // b. BALANCE_DRIFT_QUICK
  const driftQuick = await prisma.$queryRaw`
    SELECT w.id as "walletId", w.balance as "cachedBalance", COALESCE(l."lastBalance", 0) as "ledgerBalance"
    FROM "Wallet" w
    LEFT JOIN LATERAL (
      SELECT "balanceAfter" as "lastBalance"
      FROM "LedgerEntry"
      WHERE "walletId" = w.id
      ORDER BY id DESC
      LIMIT 1
    ) l ON true
    WHERE w.balance != COALESCE(l."lastBalance", 0)
      AND (EXISTS (SELECT 1 FROM "LedgerEntry" WHERE "walletId" = w.id) OR w.balance != 0);
  `;

  // c. BALANCE_DRIFT_FULL
  const driftFull = await prisma.$queryRaw`
    SELECT w.id as "walletId", w.balance as "cachedBalance",
      COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0) as "calculatedBalance"
    FROM "Wallet" w
    LEFT JOIN "LedgerEntry" l ON w.id = l."walletId"
    GROUP BY w.id
    HAVING w.balance != COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0);
  `;

  // d. TRANSACTION_UNBALANCED
  const unbalancedTx = await prisma.$queryRaw`
    SELECT "transactionId",
      SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) as "totalDebit",
      SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END) as "totalCredit"
    FROM "LedgerEntry"
    GROUP BY "transactionId"
    HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) != SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END);
  `;

  // 2. SUM(balance) tat ca vi (ke ca SYSTEM)
  const sumRes = await prisma.$queryRaw`
    SELECT COALESCE(SUM(balance), 0) as "totalBalance" FROM "Wallet";
  `;
  const totalBalance = Number(sumRes[0]?.totalBalance || 0);

  // 3. Snapshot vi he thong
  const systemWallets = await prisma.$queryRaw`
    SELECT id, "systemCode", "ownerType", balance, "heldBalance", status
    FROM "Wallet"
    WHERE "ownerType" = 'SYSTEM'
    ORDER BY id ASC;
  `;

  // 4. Ledger count & checksum
  const ledgerRes = await prisma.$queryRaw`
    SELECT 
      COUNT(*)::text as "ledgerCount",
      COALESCE(MD5(STRING_AGG(id::text || ':' || "transactionId" || ':' || "walletId"::text || ':' || direction || ':' || amount::text || ':' || "balanceAfter"::text, ',' ORDER BY id ASC)), 'empty') as "checksum"
    FROM "LedgerEntry";
  `;

  console.log('1. RECONCILIATION:');
  console.log('  - NEGATIVE_BALANCE count:', negBalance.length);
  console.log('  - BALANCE_DRIFT_QUICK count:', driftQuick.length);
  console.log('  - BALANCE_DRIFT_FULL count:', driftFull.length);
  console.log('  - TRANSACTION_UNBALANCED count:', unbalancedTx.length);
  console.log('2. TOTAL SYSTEM BALANCE (SUM ALL WALLETS):', totalBalance);
  console.log('3. SYSTEM WALLETS SNAPSHOT:');
  console.table(systemWallets);
  console.log('4. LEDGER SNAPSHOT:');
  console.log('  - Count:', ledgerRes[0]?.ledgerCount);
  console.log('  - MD5 Checksum:', ledgerRes[0]?.checksum);
  console.log(`====================================================\n`);

  return {
    reconciliation: {
      negativeBalanceCount: negBalance.length,
      driftQuickCount: driftQuick.length,
      driftFullCount: driftFull.length,
      unbalancedTxCount: unbalancedTx.length
    },
    totalBalance,
    systemWallets,
    ledger: {
      count: ledgerRes[0]?.ledgerCount,
      checksum: ledgerRes[0]?.checksum
    }
  };
}

module.exports = { getSnapshot };

if (require.main === module) {
  getSnapshot('PRE-MIGRATION SNAPSHOT (wallet_db_k12_copy)')
    .catch(console.error)
    .finally(() => prisma.$disconnect());
}

