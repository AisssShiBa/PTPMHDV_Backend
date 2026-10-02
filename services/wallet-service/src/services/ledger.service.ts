import { LedgerDirection, OwnerType, Prisma, PrismaClient, TransferType, Wallet } from "@prisma/client";
import { randomUUID } from "crypto";
import { DomainException } from "../utils/domain.exception";
import { TransferDto, CreditDto, DebitDto } from "../dtos/wallet.dto";
import { assertWalletActive, conflict, decimalToString, insufficientBalance, money } from "../utils/wallet.helpers";

const HttpStatus = { NOT_FOUND: 404, BAD_REQUEST: 400, INTERNAL_SERVER_ERROR: 500 };
const prisma = new PrismaClient();

export class LedgerService {
  async transfer(dto: TransferDto) {
    if (dto.fromUserId === dto.toUserId) {
      throw new DomainException(HttpStatus.BAD_REQUEST, "SAME_WALLET_TRANSFER", "Wallets must differ");
    }
    const amount = money(dto.amount);

    return await prisma.$transaction(async (tx) => {
      const from = await this.findWalletTx(tx, dto.fromUserId, OwnerType.USER);
      const to = await this.findWalletTx(tx, dto.toUserId, OwnerType.USER);

      return await this.moveMoneyTxInternal(tx, {
        fromWallet: from,
        toWallet: to,
        amount,
        referenceId: dto.referenceId,
        transferType: TransferType.P2P_TRANSFER,
      });
    });
  }

  async credit(userId: string, dto: CreditDto, ownerType: OwnerType = OwnerType.USER) {
    const transferType = dto.transferType ?? TransferType.TOPUP;
    const amount = money(dto.amount);

    return await prisma.$transaction(async (tx) => {
      const destination = await this.findWalletTx(tx, userId, ownerType);
      const systemWallet = await this.getSystemWalletTx(tx);

      return await this.moveMoneyTxInternal(tx, {
        fromWallet: systemWallet,
        toWallet: destination,
        amount,
        referenceId: dto.referenceId,
        transferType,
      });
    });
  }

  async debit(userId: string, dto: DebitDto, ownerType: OwnerType = OwnerType.USER) {
    const transferType = dto.transferType ?? TransferType.PAYMENT;
    const amount = money(dto.amount);

    return await prisma.$transaction(async (tx) => {
      const source = await this.findWalletTx(tx, userId, ownerType);
      const systemWallet = await this.getSystemWalletTx(tx);

      return await this.moveMoneyTxInternal(tx, {
        fromWallet: source,
        toWallet: systemWallet,
        amount,
        referenceId: dto.referenceId,
        transferType,
      });
    });
  }

  async getSystemWalletTx(tx: Prisma.TransactionClient): Promise<Wallet> {
    const wallet = await tx.wallet.findFirst({ where: { ownerType: OwnerType.SYSTEM } });
    if (!wallet) throw new DomainException(HttpStatus.INTERNAL_SERVER_ERROR, "SYSTEM_WALLET_NOT_FOUND", "System wallet missing");
    return wallet;
  }

  async findWalletTx(tx: Prisma.TransactionClient, userId: string, ownerType: OwnerType): Promise<Wallet> {
    const wallet = await tx.wallet.findFirst({ where: { userId, ownerType } });
    if (!wallet) throw new DomainException(HttpStatus.NOT_FOUND, "WALLET_NOT_FOUND", "Wallet was not found");
    return wallet;
  }

  async moveMoneyTxInternal(tx: Prisma.TransactionClient, input: {
    fromWallet: Wallet;
    toWallet: Wallet;
    amount: Prisma.Decimal;
    referenceId: string;
    transferType: TransferType;
    consumeHeldFrom?: boolean;
    bypassLockedFrom?: boolean;
    note?: string;
  }) {
    const { fromWallet, toWallet, amount } = input;

    const replay = await tx.ledgerEntry.findUnique({
      where: { walletId_referenceId: { walletId: fromWallet.id, referenceId: input.referenceId } }
    });

    if (replay) {
      if (
        replay.direction !== LedgerDirection.DEBIT ||
        replay.transferType !== input.transferType ||
        !replay.amount.equals(amount)
      ) {
        throw conflict("REFERENCE_ID_REUSED", "referenceId was used with a different operation");
      }

      const toWalletDb = await tx.wallet.findUnique({ where: { id: toWallet.id } });
      const fromWalletDb = await tx.wallet.findUnique({ where: { id: fromWallet.id } });

      return {
        sourceWallet: fromWalletDb!,
        destinationWallet: toWalletDb!,
        transactionId: replay.transactionId,
        replayed: true,
      };
    }

    assertWalletActive(fromWallet, input.bypassLockedFrom);
    assertWalletActive(toWallet, false);

    if (fromWallet.currency !== toWallet.currency) throw conflict("CURRENCY_MISMATCH", "Wallet currencies must match");

    if (input.consumeHeldFrom) {
      if (fromWallet.heldBalance.lt(amount)) throw conflict("HOLD_BALANCE_INCONSISTENT", "Hold amount exceeds held balance");
      await tx.wallet.update({
        where: { id: fromWallet.id },
        data: { heldBalance: { decrement: amount } }
      });
    } else if (fromWallet.ownerType !== OwnerType.SYSTEM && fromWallet.balance.sub(fromWallet.heldBalance).lt(amount)) {
      throw insufficientBalance();
    }

    const updatedSource = await tx.wallet.update({
      where: { id: fromWallet.id },
      data: { balance: { decrement: amount } }
    });

    const updatedDest = await tx.wallet.update({
      where: { id: toWallet.id },
      data: { balance: { increment: amount } }
    });

    const transactionId = randomUUID();

    await tx.ledgerEntry.create({
      data: {
        transactionId,
        walletId: fromWallet.id,
        direction: LedgerDirection.DEBIT,
        amount,
        balanceAfter: updatedSource.balance,
        referenceId: input.referenceId,
        transferType: input.transferType,
        note: input.note,
      }
    });

    await tx.ledgerEntry.create({
      data: {
        transactionId,
        walletId: toWallet.id,
        direction: LedgerDirection.CREDIT,
        amount,
        balanceAfter: updatedDest.balance,
        referenceId: input.referenceId,
        transferType: input.transferType,
        note: input.note,
      }
    });

    if (fromWallet.ownerType === OwnerType.USER && fromWallet.userId) {
      await tx.walletOutboxEvent.create({
        data: {
          topic: 'wallet.balance_deducted',
          payload: {
            userId: fromWallet.userId,
            amount: decimalToString(amount),
            balanceAfter: decimalToString(updatedSource.balance),
            transferType: input.transferType,
            referenceId: input.referenceId,
            transactionId,
            note: input.note || '',
          }
        }
      });
    }

    if (toWallet.ownerType === OwnerType.USER && toWallet.userId) {
      await tx.walletOutboxEvent.create({
        data: {
          topic: 'wallet.balance_added',
          payload: {
            userId: toWallet.userId,
            amount: decimalToString(amount),
            balanceAfter: decimalToString(updatedDest.balance),
            transferType: input.transferType,
            referenceId: input.referenceId,
            transactionId,
            note: input.note || '',
          }
        }
      });
    }

    return {
      sourceWallet: updatedSource,
      destinationWallet: updatedDest,
      transactionId,
      replayed: false,
    };
  }
}
