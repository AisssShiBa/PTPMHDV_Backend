import { HoldStatus, OwnerType, PrismaClient, TransferType } from "@prisma/client";
import { DomainException } from "../utils/domain.exception";
import { assertWalletActive, conflict, insufficientBalance, money } from "../utils/wallet.helpers";
import { LedgerService } from "./ledger.service";

const HttpStatus = { NOT_FOUND: 404, BAD_REQUEST: 400, CONFLICT: 409 };
const prisma = new PrismaClient();

export class WalletHoldService {
  constructor(private readonly ledgerService: LedgerService) { }

  async createHold(
    userId: string,
    amountValue: string,
    referenceId: string,
    expiresAtValue: string,
    ownerType: OwnerType = OwnerType.USER,
    destUserId: string,
    destOwnerType: OwnerType = OwnerType.USER,
  ) {
    const amount = money(amountValue);
    const expiresAt = new Date(expiresAtValue);
    if (expiresAt.getTime() <= Date.now()) {
      throw new DomainException(HttpStatus.BAD_REQUEST, "INVALID_HOLD_EXPIRY", "expiresAt must be in the future");
    }

    return await prisma.$transaction(async (tx) => {
      const wallet = await this.ledgerService.findWalletTx(tx, userId, ownerType);
      const destWallet = await this.ledgerService.findWalletTx(tx, destUserId, destOwnerType);

      const existing = await tx.walletHold.findUnique({
        where: { sourceWalletId_referenceId: { sourceWalletId: wallet.id, referenceId } }
      });

      if (existing) {
        if (!existing.amount.equals(amount)) {
          throw conflict("REFERENCE_ID_REUSED", "referenceId was used with a different amount");
        }
        return { hold: existing, replayed: true };
      }

      assertWalletActive(wallet);
      if (wallet.balance.sub(wallet.heldBalance).lt(amount)) {
        throw insufficientBalance();
      }

      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: { heldBalance: { increment: amount } }
      });

      const hold = await tx.walletHold.create({
        data: {
          sourceWalletId: wallet.id,
          destinationWalletId: destWallet.id,
          amount,
          referenceId,
          expiresAt,
          status: HoldStatus.PENDING,
        }
      });

      return { hold, replayed: false };
    });
  }

  async captureHold(
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

      if (hold.status === HoldStatus.CAPTURED) {
        return { expired: false, balance: wallet.balance, transactionId: hold.transactionId, replayed: true };
      }

      if (hold.status === HoldStatus.RELEASED || hold.status === HoldStatus.EXPIRED) {
        throw conflict("HOLD_NOT_CAPTURABLE", "Hold has already been released");
      }

      if (hold.expiresAt.getTime() <= Date.now()) {
        await tx.wallet.update({
          where: { id: wallet.id },
          data: { heldBalance: { decrement: hold.amount } }
        });
        await tx.walletHold.update({
          where: { id: hold.id },
          data: { status: HoldStatus.EXPIRED }
        });
        throw conflict("HOLD_EXPIRED", "Hold has expired and was released");
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
        expired: false,
        balance: movement.sourceWallet.balance,
        transactionId: movement.transactionId,
        replayed: movement.replayed,
      };
    });
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

      await tx.wallet.update({
        where: { id: wallet.id },
        data: { heldBalance: { decrement: hold.amount } }
      });

      const updatedHold = await tx.walletHold.update({
        where: { id: hold.id },
        data: { status }
      });

      return { hold: updatedHold, replayed: false };
    });
  }

  async releaseExpiredHolds(limit = 100) {
    const holds = await prisma.walletHold.findMany({
      where: {
        status: HoldStatus.PENDING,
        expiresAt: { lt: new Date() }
      },
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

          if (updated.count > 0) {
            // Safe to decrement because we secured the wallet lock and hold was confirmed PENDING
            await tx.wallet.update({
              where: { id: hold.sourceWalletId },
              data: { heldBalance: { decrement: hold.amount } }
            });
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
