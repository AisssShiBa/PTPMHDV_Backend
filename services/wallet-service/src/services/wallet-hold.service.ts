import { HoldStatus, OwnerType, Prisma, PrismaClient, SystemWalletCode, TransferType } from "@prisma/client";
import { randomUUID } from "crypto";
import { DomainException } from "../utils/domain.exception";
import { assertWalletActive, conflict, decimalToString, insufficientBalance, money } from "../utils/wallet.helpers";
import { LedgerService } from "./ledger.service";
import { LimitService } from "./limit.service";
import { getVnDay } from "../utils/timezone.helper";
import { drainOutbox } from "../jobs/outbox.scheduler";

const HttpStatus = { NOT_FOUND: 404, BAD_REQUEST: 400, CONFLICT: 409 };
// A hold may be pushed forward while its owner is still settling the payment,
// but never indefinitely: past this lifetime the caller must capture or release.
const HOLD_MAX_LIFETIME_MS = Number(process.env.WALLET_HOLD_MAX_LIFETIME_MS || 24 * 60 * 60 * 1000);
// Where a hold with no explicit destination settles when captured.
const CAPTURE_SYSTEM_CODE = SystemWalletCode.SETTLEMENT;
const prisma = new PrismaClient();

export interface ReleaseExpiredHoldsOptions {
  batchSize?: number;
  instanceId?: string;
  now?: Date;
  walletId?: number;
}

export interface ReleaseExpiredHoldsResult {
  instanceId: string;
  scanned: number;
  released: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

export class WalletHoldService {
  constructor(
    private readonly ledgerService: LedgerService,
    private readonly limitService: LimitService = new LimitService()
  ) { }

  async createHold(
    userId: string,
    amountValue: string,
    referenceId: string,
    expiresAtValue: string,
    ownerType: OwnerType = OwnerType.USER,
    destUserId?: string,
    destOwnerType: OwnerType = OwnerType.USER,
  ) {
    const amount = money(amountValue);
    const expiresAt = new Date(expiresAtValue);
    if (expiresAt.getTime() <= Date.now()) {
      throw new DomainException(HttpStatus.BAD_REQUEST, "INVALID_HOLD_EXPIRY", "expiresAt must be in the future");
    }

    return await prisma.$transaction(async (tx) => {
      // 1. Lock Wallets: Lock Wallet first to avoid deadlock
      const ids = await this.ledgerService.getWalletIds(tx, [
        { userId, ownerType }, ...(destUserId ? [{ userId: destUserId, ownerType: destOwnerType }] : [])
      ]);
      if (ids[0] === ids[1]) throw conflict('SAME_WALLET_TRANSFER', 'Wallets must differ');
      const wallets = await this.ledgerService.lockAndFetchWalletsTx(tx, ids);
      const wallet = wallets[ids[0]], destWallet = destUserId ? wallets[ids[1]] : null;

      const existing = await tx.walletHold.findUnique({
        where: { sourceWalletId_referenceId: { sourceWalletId: wallet.id, referenceId } }
      });

      if (existing) {
        if (!existing.amount.equals(amount) || existing.destinationWalletId !== (destWallet?.id ?? null)) {
          throw conflict("REFERENCE_ID_REUSED", "referenceId was used with a different amount");
        }
        return { hold: existing, replayed: true };
      }

      assertWalletActive(wallet);
      if (destWallet) {
        assertWalletActive(destWallet);
      }

      // 2. Kiểm tra hạn mức TRƯỚC KHI kiểm tra số dư (áp dụng cho USER wallet)
      let usageDay: string | null = null;
      if (wallet.ownerType === OwnerType.USER && wallet.userId) {
        const reserve = await this.limitService.checkAndReserve(
          tx,
          wallet.userId,
          amount,
          wallet.kycTier ?? 0
        );
        usageDay = reserve.usageDay;
      }

      // 3. Kiểm tra số dư khả dụng (sau khi checkAndReserve)
      if (wallet.balance.sub(wallet.heldBalance).lt(amount)) {
        throw insufficientBalance();
      }

      // 4. Cập nhật heldBalance và tạo WalletHold
      await tx.wallet.update({
        where: { id: wallet.id },
        data: { heldBalance: { increment: amount } }
      });

      const hold = await tx.walletHold.create({
        data: {
          sourceWalletId: wallet.id,
          destinationWalletId: destWallet ? destWallet.id : null,
          amount,
          referenceId,
          expiresAt,
          usageDay,
          status: HoldStatus.PENDING,
        }
      });

      return { hold, replayed: false };
    }, { maxWait: 15000, timeout: 25000 });
  }

  // Moves expiresAt forward without touching money: the held amount, the usage
  // reservation and the status all stay as they are. A caller still settling an
  // external payment uses this to keep its hold alive across an outcome it cannot
  // yet observe. Extending is monotonic and PENDING-only, so it can never revive a
  // hold that was already captured or released.
  async extendHold(
    userId: string,
    referenceId: string,
    expiresAtValue: string,
    ownerType: OwnerType = OwnerType.USER,
  ) {
    const requested = new Date(expiresAtValue);
    if (Number.isNaN(requested.getTime())) {
      throw new DomainException(HttpStatus.BAD_REQUEST, "INVALID_HOLD_EXPIRY", "expiresAt must be a valid date");
    }
    if (requested.getTime() <= Date.now()) {
      throw new DomainException(HttpStatus.BAD_REQUEST, "INVALID_HOLD_EXPIRY", "expiresAt must be in the future");
    }

    return await prisma.$transaction(async (tx) => {
      // Same lock order as capture/release/sweeper: the Wallet row comes first so
      // two workers cannot deadlock against each other through WalletHold.
      const wallet = await this.ledgerService.findWalletTx(tx, userId, ownerType);
      const hold = await tx.walletHold.findUnique({
        where: { sourceWalletId_referenceId: { sourceWalletId: wallet.id, referenceId } }
      });

      if (!hold) throw new DomainException(HttpStatus.NOT_FOUND, "HOLD_NOT_FOUND", "Hold was not found");
      if (hold.status === HoldStatus.CAPTURED) {
        throw conflict("HOLD_ALREADY_CAPTURED", "Captured holds cannot be extended");
      }
      if (hold.status !== HoldStatus.PENDING) {
        throw conflict("HOLD_NOT_EXTENDABLE", "Only a pending hold can be extended");
      }

      // A shorter or equal expiry is a replay, not a request to shrink the hold.
      if (requested.getTime() <= hold.expiresAt.getTime()) {
        return { hold, replayed: true, extended: false };
      }
      if (requested.getTime() > hold.createdAt.getTime() + HOLD_MAX_LIFETIME_MS) {
        throw new DomainException(HttpStatus.BAD_REQUEST, "HOLD_LIFETIME_EXCEEDED",
          `A hold may not stay open longer than ${HOLD_MAX_LIFETIME_MS}ms`);
      }

      // Conditional on PENDING and on the expiry still being shorter, so a
      // concurrent release/expiry or a competing extend cannot be overwritten.
      const updated = await tx.walletHold.updateMany({
        where: { id: hold.id, status: HoldStatus.PENDING, expiresAt: { lt: requested } },
        data: { expiresAt: requested }
      });
      if (updated.count !== 1) {
        throw conflict("HOLD_NOT_EXTENDABLE", "Hold is no longer pending");
      }

      const extended = await tx.walletHold.findUnique({ where: { id: hold.id } });
      return { hold: extended!, replayed: false, extended: true };
    }, { maxWait: 15000, timeout: 25000 });
  }

  async captureHold(
    userId: string,
    referenceId: string,
    ownerType: OwnerType = OwnerType.USER,
  ) {
    const result = await prisma.$transaction(async (tx) => {
      const source = await tx.wallet.findUnique({ where: { userId_ownerType: { userId, ownerType } } });
      if (!source) throw new DomainException(404, 'WALLET_NOT_FOUND', 'Wallet not found');
      const candidate = await tx.walletHold.findUnique({ where: { sourceWalletId_referenceId: { sourceWalletId: source.id, referenceId } } });
      if (!candidate) throw new DomainException(404, 'HOLD_NOT_FOUND', 'Hold not found');
      const ids = [source.id];
      if (candidate.destinationWalletId) ids.push(candidate.destinationWalletId);
      else {
        // A hold with no explicit destination is settlement-bound: cash-out and
        // every other platform payment settle into SYSTEM SETTLEMENT (plan §5.4
        // K12). MAIN stays the default for admin adjustments only.
        const system = await tx.wallet.findUniqueOrThrow({ where: { systemCode: CAPTURE_SYSTEM_CODE } });
        ids.push(system.id);
      }
      const wallets = await this.ledgerService.lockAndFetchWalletsTx(tx, ids);
      const wallet = wallets[source.id];
      const hold = await tx.walletHold.findUnique({
        where: { sourceWalletId_referenceId: { sourceWalletId: wallet.id, referenceId } }
      });

      if (!hold) throw new DomainException(HttpStatus.NOT_FOUND, "HOLD_NOT_FOUND", "Hold was not found");

      if (hold.status === HoldStatus.CAPTURED) {
        return { expired: false as const, balance: wallet.balance, transactionId: hold.transactionId, replayed: true };
      }

      if (hold.status === HoldStatus.EXPIRED) {
        throw conflict("HOLD_EXPIRED", "Hold has expired and was released");
      }

      if (hold.status === HoldStatus.RELEASED) {
        throw conflict("HOLD_NOT_CAPTURABLE", "Hold has already been released");
      }

      // Xử lý Hold hết hạn inline
      if (hold.expiresAt.getTime() <= Date.now()) {
        const updated = await tx.walletHold.updateMany({
          where: { id: hold.id, status: HoldStatus.PENDING },
          data: { status: HoldStatus.EXPIRED }
        });

        if (updated.count === 1) {
          const currentHeld = wallet.heldBalance;
          if (currentHeld.lt(hold.amount)) {
            throw new DomainException(
              HttpStatus.BAD_REQUEST,
              'NEGATIVE_HELD_BALANCE',
              `heldBalance (${currentHeld.toString()}) would become negative if hold amount (${hold.amount.toString()}) is deducted`
            );
          }
          await tx.wallet.update({
            where: { id: wallet.id },
            data: { heldBalance: { decrement: hold.amount } }
          });

          // Hoàn hạn mức đúng row usageDay
          const usageDay = hold.usageDay || getVnDay(hold.createdAt);
          if (wallet.userId && wallet.ownerType === OwnerType.USER) {
            await this.limitService.refundUsage(tx, wallet.userId, hold.amount, usageDay);
          }
        }

        // Commit the release and usage refund first. Throwing inside the
        // transaction would roll them back and leave this hold PENDING.
        return { expired: true as const };
      }

      let destWallet;
      if (hold.destinationWalletId) {
        const found = await tx.wallet.findUnique({ where: { id: hold.destinationWalletId } });
        if (!found) throw new DomainException(HttpStatus.NOT_FOUND, "DESTINATION_NOT_FOUND", "Destination wallet not found");
        destWallet = found;
      } else {
        destWallet = await this.ledgerService.getSystemWalletTx(tx, CAPTURE_SYSTEM_CODE);
      }

      const movement = await this.ledgerService.moveMoneyTxInternal(tx, {
        fromWallet: wallet,
        toWallet: destWallet,
        amount: hold.amount,
        referenceId,
        transferType: TransferType.PAYMENT,
        consumeHeldFrom: true,
      });

      await tx.walletHold.update({
        where: { id: hold.id },
        data: {
          status: HoldStatus.CAPTURED,
          transactionId: movement.transactionId
        }
      });

      return {
        expired: false as const,
        balance: movement.sourceWallet.balance,
        transactionId: movement.transactionId,
        replayed: movement.replayed,
      };
    }, { maxWait: 15000, timeout: 25000 });
    if (result.expired) throw conflict("HOLD_EXPIRED", "Hold has expired and was released");
    void drainOutbox().catch(error => {
      console.error('[Wallet Outbox] Post-commit drain failed', error instanceof Error ? error.message : 'unknown error');
    });
    return result;
  }

  // Chuyển đổi theo cơ chế SKIP LOCKED
  // Tránh tình trạng nhiều server chạy song song cùng nhảy vào quét tranh chấp
  async releaseHold(
    userId: string,
    referenceId: string,
    ownerType: OwnerType = OwnerType.USER,
  ) {
    return await prisma.$transaction(async (tx) => {
      const wallet = await this.ledgerService.findWalletTx(tx, userId, ownerType);
      // Khóa ví trước để đảm bảo thứ tự khóa nhất quán (Ví -> Hold)
      await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${wallet.id} FOR UPDATE`;
      const hold = await tx.walletHold.findUnique({
        where: { sourceWalletId_referenceId: { sourceWalletId: wallet.id, referenceId } }
      });

      if (!hold) throw new DomainException(HttpStatus.NOT_FOUND, "HOLD_NOT_FOUND", "Hold was not found");
      if (hold.status === HoldStatus.CAPTURED) throw conflict("HOLD_ALREADY_CAPTURED", "Captured holds cannot be released");
      if (hold.status === HoldStatus.RELEASED || hold.status === HoldStatus.EXPIRED) {
        return { hold, replayed: true };
      }

      const status = hold.expiresAt.getTime() <= Date.now() ? HoldStatus.EXPIRED : HoldStatus.RELEASED;

      // Idempotent state transition: updateMany chỉ thành công khi status đang là PENDING
      const updated = await tx.walletHold.updateMany({
        where: { id: hold.id, status: HoldStatus.PENDING },
        data: { status }
      });

      if (updated.count === 1) {
        const currentHeld = wallet.heldBalance;
        if (currentHeld.lt(hold.amount)) {
          throw new DomainException(
            HttpStatus.BAD_REQUEST,
            'NEGATIVE_HELD_BALANCE',
            `heldBalance (${currentHeld.toString()}) would become negative if hold amount (${hold.amount.toString()}) is deducted`
          );
        }
        await tx.wallet.update({
          where: { id: wallet.id },
          data: { heldBalance: { decrement: hold.amount } }
        });

        // Hoàn lại hạn mức đúng row usageDay
        const usageDay = hold.usageDay || getVnDay(hold.createdAt);
        if (wallet.userId && wallet.ownerType === OwnerType.USER) {
          await this.limitService.refundUsage(tx, wallet.userId, hold.amount, usageDay);
        }
      }

      const updatedHold = await tx.walletHold.findUnique({ where: { id: hold.id } });
      return { hold: updatedHold!, replayed: updated.count === 0 };
    });
  }

  async releaseExpiredHolds(
    optionsOrLimit?: number | ReleaseExpiredHoldsOptions
  ): Promise<ReleaseExpiredHoldsResult & { valueOf(): number }> {
    const startTime = Date.now();
    let batchSize = 100;
    let instanceId = process.env.INSTANCE_ID || process.env.HOSTNAME || randomUUID();
    let now = new Date();
    let walletId: number | undefined;

    if (typeof optionsOrLimit === 'number') {
      batchSize = optionsOrLimit;
    } else if (optionsOrLimit && typeof optionsOrLimit === 'object') {
      if (optionsOrLimit.batchSize !== undefined) batchSize = optionsOrLimit.batchSize;
      if (optionsOrLimit.instanceId !== undefined) instanceId = optionsOrLimit.instanceId;
      if (optionsOrLimit.now !== undefined) now = optionsOrLimit.now;
      if (optionsOrLimit.walletId !== undefined) walletId = optionsOrLimit.walletId;
    } else {
      const envBatch = process.env.WALLET_HOLD_EXPIRY_BATCH_SIZE;
      if (envBatch) {
        const parsed = parseInt(envBatch, 10);
        if (!isNaN(parsed) && parsed > 0) batchSize = parsed;
      }
    }

    const where: Prisma.WalletHoldWhereInput = {
      status: HoldStatus.PENDING,
      expiresAt: { lte: now }
    };
    if (walletId !== undefined) {
      where.sourceWalletId = walletId;
    }

    // 1. Quét danh sách ứng viên (candidate batch) không khóa theo thứ tự expiresAt ASC, id ASC
    const candidates = await prisma.walletHold.findMany({
      where,
      select: {
        id: true,
        sourceWalletId: true
      },
      orderBy: [
        { expiresAt: 'asc' },
        { id: 'asc' }
      ],
      take: batchSize
    });

    const scanned = candidates.length;
    let released = 0;
    let skipped = 0;
    let errors = 0;

    for (const candidate of candidates) {
      try {
        await prisma.$transaction(async (tx) => {
          // Khóa Ví trước để nhất quán thứ tự Ví -> Hold
          const walletRows = await tx.$queryRaw<Array<{
            id: number;
            heldBalance: Prisma.Decimal;
            userId: string | null;
            ownerType: OwnerType;
          }>>`
            SELECT id, "heldBalance", "userId", "ownerType"
            FROM "Wallet"
            WHERE id = ${candidate.sourceWalletId}
            FOR UPDATE
          `;

          if (!walletRows || walletRows.length === 0) {
            skipped++;
            return;
          }
          const wallet = walletRows[0];

          // Khóa Hold với SKIP LOCKED
          const holdRows = await tx.$queryRaw<Array<{
            id: string;
            amount: Prisma.Decimal;
            usageDay: string | null;
            createdAt: Date;
            status: HoldStatus;
            expiresAt: Date;
          }>>`
            SELECT id, amount, "usageDay", "createdAt", status, "expiresAt"
            FROM "WalletHold"
            WHERE id = ${candidate.id}::uuid
              AND status = ${HoldStatus.PENDING}::"HoldStatus"
              AND "expiresAt" <= ${now}
            FOR UPDATE SKIP LOCKED
          `;

          if (!holdRows || holdRows.length === 0) {
            // Đang bị instance khác khóa hoặc trạng thái đã đổi / chưa hết hạn
            skipped++;
            return;
          }

          const hold = holdRows[0];
          const holdAmount = new Prisma.Decimal(hold.amount);
          const currentHeld = new Prisma.Decimal(wallet.heldBalance);

          // Kiểm tra không để heldBalance âm - nếu sắp âm thì rollback transaction đó, không clamp im lặng
          if (currentHeld.lt(holdAmount)) {
            throw new DomainException(
              HttpStatus.BAD_REQUEST,
              'NEGATIVE_HELD_BALANCE',
              `heldBalance (${currentHeld.toString()}) would become negative if hold amount (${holdAmount.toString()}) is deducted`
            );
          }

          const usageDay = hold.usageDay || getVnDay(hold.createdAt);

          // Kiểm tra không để spentDay âm (nếu là USER wallet)
          if (wallet.userId && wallet.ownerType === OwnerType.USER) {
            const usageRows = await tx.$queryRaw<Array<{ spentDay: Prisma.Decimal }>>`
              SELECT "spentDay"
              FROM "UserDailyUsage"
              WHERE "userId" = ${wallet.userId} AND "day" = ${usageDay}
              FOR UPDATE
            `;
            if (usageRows && usageRows.length > 0) {
              const currentSpent = new Prisma.Decimal(usageRows[0].spentDay);
              if (currentSpent.lt(holdAmount)) {
                throw new DomainException(
                  HttpStatus.BAD_REQUEST,
                  'NEGATIVE_SPENT_DAY',
                  `spentDay (${currentSpent.toString()}) would become negative if hold amount (${holdAmount.toString()}) is refunded`
                );
              }
            }
          }

          // Cập nhật WalletHold PENDING -> EXPIRED có điều kiện
          const updated = await tx.walletHold.updateMany({
            where: { id: hold.id, status: HoldStatus.PENDING, expiresAt: { lt: new Date() } },
            data: { status: HoldStatus.EXPIRED }
          });

          if (updated.count !== 1) {
            skipped++;
            return;
          }

          // Trừ đúng amount của hold đó trên heldBalance
          await tx.wallet.update({
            where: { id: wallet.id },
            data: { heldBalance: { decrement: holdAmount } }
          });

          // Hoàn hạn mức đúng row usageDay (trừ trực tiếp không clamp GREATEST, kiểm tra không để âm)
          if (wallet.userId && wallet.ownerType === OwnerType.USER) {
            await this.limitService.refundUsage(tx, wallet.userId, holdAmount, usageDay);
          }

          released++;
        });
      } catch (e: any) {
        errors++;
        console.error(JSON.stringify({
          event: 'HOLD_RELEASE_ERROR',
          instanceId,
          holdId: candidate.id,
          walletId: candidate.sourceWalletId,
          code: e?.code || 'UNKNOWN_ERROR',
          message: e?.message || String(e)
        }));
      }
    }

    const durationMs = Date.now() - startTime;
    const summary = {
      instanceId,
      scanned,
      released,
      skipped,
      errors,
      durationMs,
      valueOf() { return this.released; }
    };

    console.log(JSON.stringify({
      instanceId,
      scanned,
      released,
      skipped,
      errors,
      durationMs
    }));

    return summary;
  }

  async refundCapture(
    userId: string,
    input: {
      referenceId: string;
      originalReferenceId: string;
      amount: string;
    },
    ownerType: OwnerType = OwnerType.USER,
  ) {
    const reqAmount = money(input.amount);

    const result = await prisma.$transaction(async (tx) => {
      // 1. Tìm ví nguồn (ví nhận lại tiền hoàn)
      const source = await tx.wallet.findUnique({
        where: { userId_ownerType: { userId, ownerType } },
      });
      if (!source) {
        throw new DomainException(HttpStatus.NOT_FOUND, 'WALLET_NOT_FOUND', 'Wallet not found');
      }

      // Kiểm tra xem referenceId này đã được sử dụng ở hold nào khác chưa
      const holdWithRef = await tx.walletHold.findFirst({
        where: { refundReferenceId: input.referenceId },
      });

      // 2. Tìm bút toán Hold/Capture gốc theo sourceWalletId và originalReferenceId
      const candidate = await tx.walletHold.findUnique({
        where: {
          sourceWalletId_referenceId: {
            sourceWalletId: source.id,
            referenceId: input.originalReferenceId,
          },
        },
      });

      if (!candidate || (candidate.status !== HoldStatus.CAPTURED && candidate.status !== HoldStatus.REFUNDED)) {
        throw new DomainException(HttpStatus.NOT_FOUND, 'CAPTURE_NOT_FOUND', 'Original capture not found');
      }

      if (holdWithRef && holdWithRef.id !== candidate.id) {
        throw conflict('REFERENCE_ID_REUSED', 'referenceId was used with a different operation');
      }

      // 3. Xác định ví đối ứng (ví bị trừ tiền hoàn):
      //    P2P: ví đích ban đầu (destinationWalletId)
      //    Non-P2P: ví hệ thống SETTLEMENT
      let destWalletId: number;
      if (candidate.destinationWalletId) {
        destWalletId = candidate.destinationWalletId;
      } else {
        const system = await tx.wallet.findUniqueOrThrow({
          where: { systemCode: SystemWalletCode.SETTLEMENT },
        });
        destWalletId = system.id;
      }

      // 4. Khóa cả hai ví theo thứ tự nhất quán để tránh deadlock
      const ids = [source.id, destWalletId];
      const wallets = await this.ledgerService.lockAndFetchWalletsTx(tx, ids);
      const lockedSource = wallets[source.id];
      const lockedFrom = wallets[destWalletId];

      // 5. Re-fetch hold sau khi có lock để chống race condition
      const hold = await tx.walletHold.findUnique({
        where: {
          sourceWalletId_referenceId: {
            sourceWalletId: source.id,
            referenceId: input.originalReferenceId,
          },
        },
      });

      if (!hold || (hold.status !== HoldStatus.CAPTURED && hold.status !== HoldStatus.REFUNDED)) {
        throw new DomainException(HttpStatus.NOT_FOUND, 'CAPTURE_NOT_FOUND', 'Original capture not found');
      }

      // Lũy đẳng và Chống hoàn đôi
      if (hold.status === HoldStatus.REFUNDED) {
        if (hold.refundReferenceId === input.referenceId) {
          if (!hold.amount.equals(reqAmount)) {
            throw conflict('REFERENCE_ID_REUSED', 'referenceId was used with a different operation');
          }
          return {
            transactionId: hold.refundTransactionId || '',
            referenceId: input.referenceId,
            status: 'COMPLETED',
            amount: decimalToString(hold.amount),
            originalReferenceId: input.originalReferenceId,
            createdAt: new Date(),
            replayed: true,
          };
        } else {
          throw conflict('ALREADY_REFUNDED', 'Capture has already been refunded');
        }
      }

      // 6. Kiểm tra số tiền hoàn (chỉ hỗ trợ hoàn toàn phần)
      if (!hold.amount.equals(reqAmount)) {
        throw new DomainException(422, 'AMOUNT_MISMATCH', 'Refund amount does not match original capture amount', {
          capturedAmount: hold.amount.toString(),
          refundAmount: reqAmount.toString(),
        });
      }

      // 7. Kiểm tra số dư ví bị trừ (INSUFFICIENT_FUNDS)
      const available = lockedFrom.balance.sub(lockedFrom.heldBalance);
      if (lockedFrom.ownerType !== OwnerType.SYSTEM && available.lt(reqAmount)) {
        throw new DomainException(422, 'INSUFFICIENT_FUNDS', 'Insufficient available balance for refund', {
          available: decimalToString(available),
          required: decimalToString(reqAmount),
          missing: decimalToString(reqAmount.sub(available)),
        });
      }

      // 8. Thực hiện bút toán đảo chiều (Debit lockedFrom, Credit lockedSource)
      const movement = await this.ledgerService.moveMoneyTxInternal(tx, {
        fromWallet: lockedFrom,
        toWallet: lockedSource,
        amount: reqAmount,
        referenceId: input.referenceId,
        transferType: TransferType.REFUND,
        note: `Refund for ${input.originalReferenceId}`,
      });

      // 9. Cập nhật trạng thái WalletHold thành REFUNDED
      await tx.walletHold.update({
        where: { id: hold.id },
        data: {
          status: HoldStatus.REFUNDED,
          refundReferenceId: input.referenceId,
          refundTransactionId: movement.transactionId,
        },
      });

      return {
        transactionId: movement.transactionId,
        referenceId: input.referenceId,
        status: 'COMPLETED',
        amount: decimalToString(reqAmount),
        originalReferenceId: input.originalReferenceId,
        createdAt: new Date(),
        replayed: movement.replayed,
      };
    }, { maxWait: 15000, timeout: 25000 });

    void drainOutbox().catch(error => {
      console.error('[Wallet Outbox] Post-commit drain failed', error instanceof Error ? error.message : 'unknown error');
    });

    return result;
  }
}
