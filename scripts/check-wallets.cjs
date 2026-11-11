const path = require('path');
const { PrismaClient } = require(path.resolve(__dirname, '../services/wallet-service/node_modules/@prisma/client'));

const pgPassword = process.env.POSTGRES_PASSWORD || '404897ba313a20d9a166a1db0625276a77186fc0160c690a5e6e93ee09e06720';
const dbUrl = process.env.WALLET_DATABASE_URL || `postgresql://postgres:${pgPassword}@localhost:5432/wallet_service?schema=public`;

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: dbUrl
    }
  }
});

async function main() {
  const wallets = await prisma.wallet.findMany();
  let totalBalance = 0n;
  let totalHeld = 0n;
  let negativeCount = 0;

  for (const w of wallets) {
    const bal = BigInt(Math.round(Number(w.balance)));
    const held = BigInt(Math.round(Number(w.heldBalance)));
    totalBalance += bal;
    totalHeld += held;
    if (bal < 0n && w.ownerType !== 'SYSTEM') {
      negativeCount++;
    }
  }

  const ledgerSummary = await prisma.ledgerEntry.groupBy({
    by: ['direction'],
    _sum: { amount: true }
  });

  let totalCredit = 0n;
  let totalDebit = 0n;
  for (const row of ledgerSummary) {
    const amt = BigInt(Math.round(Number(row._sum.amount || 0)));
    if (row.direction === 'CREDIT') totalCredit = amt;
    if (row.direction === 'DEBIT') totalDebit = amt;
  }

  console.log('=== GLOBAL WALLET AUDIT REPORT ===');
  console.log(`WALLETS_COUNT:        ${wallets.length}`);
  console.log(`TOTAL_BALANCE:        ${totalBalance.toString()} VND`);
  console.log(`TOTAL_HELD_BALANCE:   ${totalHeld.toString()} VND`);
  console.log(`NEGATIVE_WALLETS:     ${negativeCount}`);
  console.log(`TOTAL_LEDGER_CREDIT:  ${totalCredit.toString()} VND`);
  console.log(`TOTAL_LEDGER_DEBIT:   ${totalDebit.toString()} VND`);
  console.log(`LEDGER_DIFF:          ${(totalCredit - totalDebit).toString()} VND`);
  console.log(`CONSERVATION_STATUS:  ${totalBalance === 0n ? 'CONSERVED (0 VND)' : 'DRIFT DETECTED'}`);
  console.log('==================================');
}

main().catch(console.error).finally(() => prisma.$disconnect());
