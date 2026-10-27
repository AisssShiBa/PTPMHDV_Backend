import { PrismaClient, OwnerType } from '@prisma/client';

const prisma = new PrismaClient();
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://localhost:3002';
const INTERNAL_KEY = process.env.INTERNAL_KEY || 'default_internal_secret_key_123456';

// Kiểm tra xem cấp KYC người dùng là bao nhiêu.
// B1: Lấy danh sách ví cần kiểm tra.
// B2: Quét qua từng ví.
// B3: Gọi đến user-service để lấy cấp KYC thực tế của người dùng.
// B4: Cập nhật lại cấp KYC cho ví.
export async function backfillKycTier() {
  console.log('--- Starting KYC Tier Backfill from user-service ---');

  const userWallets = await prisma.wallet.findMany({
    where: {
      ownerType: OwnerType.USER,
      userId: { not: null },
    },
    select: { id: true, userId: true, kycTier: true },
  });

  console.log(`Found ${userWallets.length} user wallets to check.`);

  let updatedCount = 0;
  for (const wallet of userWallets) {
    if (!wallet.userId) continue;

    try {
      const res = await fetch(`${USER_SERVICE_URL}/api/users/by-auth/${wallet.userId}`, {
        headers: {
          'x-internal-key': INTERNAL_KEY,
        },
      });

      if (!res.ok) {
        console.warn(`User ${wallet.userId} not found in user-service (status ${res.status})`);
        continue;
      }

      const body: any = await res.json();
      const actualTier = body?.data?.kycTier;

      if (typeof actualTier === 'number' && actualTier !== wallet.kycTier) {
        await prisma.wallet.update({
          where: { id: wallet.id },
          data: { kycTier: actualTier },
        });
        console.log(`Updated wallet ${wallet.id} (user ${wallet.userId}): tier ${wallet.kycTier} -> ${actualTier}`);
        updatedCount++;
      }
    } catch (e: any) {
      console.error(`Failed to backfill for wallet ${wallet.id}:`, e.message || e);
    }
  }

  console.log(`✅ Backfill complete. Updated ${updatedCount} wallets.`);
}

backfillKycTier()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
