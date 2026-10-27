import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function seedLimitPolicies() {
  const policies = [
    { kycTier: 0, perTxn: '200000', perDay: '500000', perMonth: '2000000' },
    { kycTier: 1, perTxn: '10000000', perDay: '20000000', perMonth: '100000000' },
    { kycTier: 2, perTxn: '50000000', perDay: '100000000', perMonth: '500000000' },
  ];

  for (const p of policies) {
    await prisma.limitPolicy.upsert({
      where: { kycTier: p.kycTier },
      update: {
        perTxn: p.perTxn,
        perDay: p.perDay,
        perMonth: p.perMonth,
      },
      create: {
        kycTier: p.kycTier,
        perTxn: p.perTxn,
        perDay: p.perDay,
        perMonth: p.perMonth,
      },
    });
  }
  console.log('✅ Limit policies seeded successfully');
}

seedLimitPolicies()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
