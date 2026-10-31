import { HoldStatus, OwnerType, Prisma, PrismaClient, TransferType } from "@prisma/client";
import { DomainException } from "../utils/domain.exception";
import { assertWalletActive, conflict, insufficientBalance, money } from "../utils/wallet.helpers";
import { LedgerService } from "./ledger.service";
import { LimitService } from "./limit.service";
import { getVnDay } from "../utils/timezone.helper";
import { drainOutbox } from "../jobs/outbox.scheduler";

const HttpStatus = { NOT_FOUND: 404, BAD_REQUEST: 400, CONFLICT: 409 };
const prisma = new PrismaClient();

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
        const system = await tx.wallet.findUniqueOrThrow({ where: { systemCode: 'MAIN' } });
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

      if (hold.status === HoldStatus.RELEASED || hold.status === HoldStatus.EXPIRED) {
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
          const decrementAmount = currentHeld.gt(0)
            ? (currentHeld.lt(hold.amount) ? currentHeld : hold.amount)
            : new Prisma.Decimal(0);
          if (decrementAmount.gt(0)) {
            await tx.wallet.update({
              where: { id: wallet.id },
              data: { heldBalance: { decrement: decrementAmount } }
            });
          }

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
        destWallet = await this.ledgerService.getSystemWalletTx(tx);
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

  async releaseHold(
    userId: string,
    referenceId: string,
    ownerType: OwnerType = OwnerType.USER,
  ) {
    return await prisma.$transaction(async (tx) => {
      const wallet = await this.ledgerService.findWalletTx(tx, userId, ownerType);
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
        const decrementAmount = currentHeld.gt(0)
          ? (currentHeld.lt(hold.amount) ? currentHeld : hold.amount)
          : new Prisma.Decimal(0);
        if (decrementAmount.gt(0)) {
          await tx.wallet.update({
            where: { id: wallet.id },
            data: { heldBalance: { decrement: decrementAmount } }
          });
        }

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

  async releaseExpiredHolds(limit = 100) {
    const holds = await prisma.walletHold.findMany({
      where: {
        status: HoldStatus.PENDING,
        expiresAt: { lt: new Date() }
      },
      include: { sourceWallet: true },
      take: limit
    });

    let released = 0;
    for (const hold of holds) {
      try {
        await prisma.$transaction(async (tx) => {
          // Lock wallet first to prevent deadlock and race conditions
          await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${hold.sourceWalletId} FOR UPDATE`;

          // Optimistic update: only update if it's still PENDING
          const updated = await tx.walletHold.updateMany({
            where: { id: hold.id, status: HoldStatus.PENDING },
            data: { status: HoldStatus.EXPIRED }
          });

          if (updated.count === 1) {
            const w = await tx.wallet.findUnique({
              where: { id: hold.sourceWalletId },
              select: { heldBalance: true }
            });
            const currentHeld = w?.heldBalance || new Prisma.Decimal(0);
            const decrementAmount = currentHeld.gt(0)
              ? (currentHeld.lt(hold.amount) ? currentHeld : hold.amount)
              : new Prisma.Decimal(0);
            if (decrementAmount.gt(0)) {
              await tx.wallet.update({
                where: { id: hold.sourceWalletId },
                data: { heldBalance: { decrement: decrementAmount } }
              });
            }

            // Hoàn hạn mức đúng row usageDay
            const usageDay = hold.usageDay || getVnDay(hold.createdAt);
            if (hold.sourceWallet.userId && hold.sourceWallet.ownerType === OwnerType.USER) {
              await this.limitService.refundUsage(tx, hold.sourceWallet.userId, hold.amount, usageDay);
            }
            released++;
          }
        });
      } catch (e) {
        console.error('Failed to release hold', hold.id, e);
      }
    }
    return released;
  }
}
