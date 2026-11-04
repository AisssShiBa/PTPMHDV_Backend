import { HoldStatus, OwnerType, Prisma, PrismaClient, SystemWalletCode, TransferType } from "@prisma/client";
import { DomainException } from "../utils/domain.exception";
import { assertWalletActive, conflict, decimalToString, insufficientBalance, money } from "../utils/wallet.helpers";
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
        const system = await tx.wallet.findUniqueOrThrow({ where: { systemCode: SystemWalletCode.SETTLEMENT } });
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
