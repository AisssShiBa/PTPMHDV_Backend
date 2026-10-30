const path = require('path');
const { PrismaClient } = require(path.resolve(__dirname, '../services/wallet-service/node_modules/@prisma/client'));
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: 'postgresql://postgres:8932ce4c6b28dba8c13430d3317b1e51e4f8838c6b02824423f9b57b69d56d4a@localhost:5432/wallet_service?schema=public'
    }
  }
});

async function main() {
  const wallets = await prisma.wallet.findMany();
  console.log('WALLETS_COUNT:', wallets.length);
  console.log('WALLETS:', wallets);
}

main().catch(console.error).finally(() => prisma.$disconnect());
