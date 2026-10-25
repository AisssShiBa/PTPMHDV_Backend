import { LimitPolicy, Prisma, PrismaClient } from '@prisma/client';
import { DomainException } from '../utils/domain.exception';
import { getVnDay, getVnMonthKey } from '../utils/timezone.helper';
import { decimalToString } from '../utils/wallet.helpers';

const prisma = new PrismaClient();

export interface LimitDetails {
  limitType: 'PER_TXN' | 'PER_DAY' | 'PER_MONTH';
  limit: string;
  used: string;
  remaining: string;
  kycTier: number;
}

export class LimitService {
  private policyCache = new Map<number, { policy: LimitPolicy; expiry: number }>();
  private readonly CACHE_TTL_MS = 60_000;

  async getPolicy(kycTier: number, client: Prisma.TransactionClient | PrismaClient = prisma): Promise<LimitPolicy> {
    const cached = this.policyCache.get(kycTier);
    if (cached && cached.expiry > Date.now()) {
      return cached.policy;
    }

    const policy = await client.limitPolicy.findUnique({
      where: { kycTier },
    });

    if (!policy) {
      throw new DomainException(
        400,
        'INVALID_KYC_TIER',
        `No limit policy found for KYC tier ${kycTier}`
      );
    }

    this.policyCache.set(kycTier, { policy, expiry: Date.now() + this.CACHE_TTL_MS });
    return policy;
  }

  clearCache() {
    this.policyCache.clear();
  }

  /**
   * checkAndReserve
   * Runs within an existing caller transaction.
   * Lock order: Caller MUST have locked Wallet first, then checkAndReserve locks UserDailyUsage.
   */
  async checkAndReserve(
    tx: Prisma.TransactionClient,
    userId: string,
    amount: Prisma.Decimal,
    kycTier: number,
    now: Date = new Date()
  ): Promise<{ usageDay: string }> {
    const policy = await this.getPolicy(kycTier, tx);

    // 1. Kiểm tra perTxn (chưa cần chạm DB)
    if (amount.gt(policy.perTxn)) {
      throw new DomainException(
        422,
        'LIMIT_EXCEEDED',
        `Giao dịch vượt hạn mức tối đa một lần (${decimalToString(policy.perTxn)} VND)`,
        {
          limitType: 'PER_TXN',
          limit: decimalToString(policy.perTxn),
          used: decimalToString(amount),
          remaining: decimalToString(policy.perTxn),
          kycTier,
        }
      );
    }

    const day = getVnDay(now);
    const monthKey = getVnMonthKey(now);

    // 2. INSERT ... ON CONFLICT (userId, day) DO NOTHING để đảm bảo row ngày hôm nay tồn tại
    await tx.$executeRaw`
      INSERT INTO "UserDailyUsage" ("userId", "day", "monthKey", "spentDay", "createdAt", "updatedAt")
      VALUES (${userId}, ${day}, ${monthKey}, 0, NOW(), NOW())
      ON CONFLICT ("userId", "day") DO NOTHING
    `;

    // 3. SELECT ... FOR UPDATE trên row đó để serialize các request cùng user cùng ngày
    const lockedRows = await tx.$queryRaw<{ spentDay: Prisma.Decimal }[]>`
      SELECT "spentDay"
      FROM "UserDailyUsage"
      WHERE "userId" = ${userId} AND "day" = ${day}
      FOR UPDATE
    `;

    if (!lockedRows || lockedRows.length === 0) {
      throw new DomainException(500, 'CONCURRENCY_ERROR', 'Failed to lock user daily usage row');
    }

    const currentSpentDay = new Prisma.Decimal(lockedRows[0].spentDay);

    // 4. Kiểm tra perDay
    const newSpentDay = currentSpentDay.add(amount);
    if (newSpentDay.gt(policy.perDay)) {
      const remaining = Prisma.Decimal.max(0, policy.perDay.sub(currentSpentDay));
      throw new DomainException(
        422,
        'LIMIT_EXCEEDED',
        `Giao dịch vượt hạn mức ngày (${decimalToString(policy.perDay)} VND)`,
        {
          limitType: 'PER_DAY',
          limit: decimalToString(policy.perDay),
          used: decimalToString(currentSpentDay),
          remaining: decimalToString(remaining),
          kycTier,
        }
      );
    }

    // 5. Kiểm tra perMonth qua SUM(spentDay) của monthKey
    // Vì row của ngày hôm nay đã được lock, tổng các ngày khác là tĩnh
    const monthSumResult = await tx.$queryRaw<{ total: Prisma.Decimal | null }[]>`
      SELECT COALESCE(SUM("spentDay"), 0) as total
      FROM "UserDailyUsage"
      WHERE "userId" = ${userId} AND "monthKey" = ${monthKey}
    `;

    const currentSpentMonth = new Prisma.Decimal(monthSumResult[0]?.total ?? 0);
    const newSpentMonth = currentSpentMonth.add(amount);

    if (newSpentMonth.gt(policy.perMonth)) {
      const remaining = Prisma.Decimal.max(0, policy.perMonth.sub(currentSpentMonth));
      throw new DomainException(
        422,
        'LIMIT_EXCEEDED',
        `Giao dịch vượt hạn mức tháng (${decimalToString(policy.perMonth)} VND)`,
        {
          limitType: 'PER_MONTH',
          limit: decimalToString(policy.perMonth),
          used: decimalToString(currentSpentMonth),
          remaining: decimalToString(remaining),
          kycTier,
        }
      );
    }

    // 6. UPDATE spentDay = spentDay + amount
    await tx.$executeRaw`
      UPDATE "UserDailyUsage"
      SET "spentDay" = "spentDay" + ${amount}, "updatedAt" = NOW()
      WHERE "userId" = ${userId} AND "day" = ${day}
    `;

    return { usageDay: day };
  }

  /**
   * refundUsage
   * Caller chịu trách nhiệm đảm bảo tính idempotent trước khi gọi hàm này.
   * Trừ spentDay đúng row usageDay, clamp để không bao giờ âm.
   */
  async refundUsage(
    tx: Prisma.TransactionClient,
    userId: string,
    amount: Prisma.Decimal,
    usageDay: string
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE "UserDailyUsage"
      SET "spentDay" = GREATEST(0, "spentDay" - ${amount}), "updatedAt" = NOW()
      WHERE "userId" = ${userId} AND "day" = ${usageDay}
    `;
  }
}
