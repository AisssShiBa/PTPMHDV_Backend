import { LedgerDirection, OwnerType, Prisma, PrismaClient, TransferType, Wallet } from "@prisma/client";
import { randomUUID } from "crypto";
import { DomainException } from "../utils/domain.exception";
import { TransferDto, CreditDto, DebitDto } from "../dtos/wallet.dto";
import { assertWalletActive, conflict, decimalToString, insufficientBalance, money } from "../utils/wallet.helpers";

const HttpStatus = { NOT_FOUND: 404, BAD_REQUEST: 400, INTERNAL_SERVER_ERROR: 500 };
const prisma = new PrismaClient();

export class LedgerService {
  private async getWalletIds(tx: Prisma.TransactionClient, specs: {userId?: string, ownerType: OwnerType}[]): Promise<number[]> {
    const ids: number[] = [];
    for (const spec of specs) {
      if (spec.userId) {
        const w = await tx.wallet.findFirst({ where: { userId: spec.userId, ownerType: spec.ownerType }, select: { id: true } });
        if (!w) throw new DomainException(HttpStatus.NOT_FOUND, "WALLET_NOT_FOUND", "Wallet was not found");
        ids.push(w.id);
      } else if (spec.ownerType === OwnerType.SYSTEM) {
        const w = await tx.wallet.findFirst({ where: { ownerType: OwnerType.SYSTEM }, select: { id: true } });
        if (!w) throw new DomainException(HttpStatus.INTERNAL_SERVER_ERROR, "SYSTEM_WALLET_NOT_FOUND", "System wallet missing");
        ids.push(w.id);
      }
    }
    return ids;
  }

  private async lockAndFetchWalletsTx(tx: Prisma.TransactionClient, ids: number[]): Promise<Record<number, Wallet>> {
    const sortedIds = [...new Set(ids)].sort((a, b) => a - b);
    if (sortedIds.length > 0) {
      await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id IN (${Prisma.join(sortedIds)}) ORDER BY id FOR UPDATE`;
    }
    const wallets = await tx.wallet.findMany({ where: { id: { in: sortedIds } } });
    const map: Record<number, Wallet> = {};
    for (const w of wallets) map[w.id] = w;
    return map;
  }

  async transfer(dto: TransferDto) {
    if (dto.fromUserId === dto.toUserId) {
      throw new DomainException(HttpStatus.BAD_REQUEST, "SAME_WALLET_TRANSFER", "Wallets must differ");
    }
    const amount = money(dto.amount);

    return await prisma.$transaction(async (tx) => {
      const ids = await this.getWalletIds(tx, [
        { userId: dto.fromUserId, ownerType: OwnerType.USER },
        { userId: dto.toUserId, ownerType: OwnerType.USER }
      ]);
      const wallets = await this.lockAndFetchWalletsTx(tx, ids);
      const from = wallets[ids[0]];
      const to = wallets[ids[1]];

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
      const ids = await this.getWalletIds(tx, [
        { userId, ownerType },
        { ownerType: OwnerType.SYSTEM }
      ]);
      const wallets = await this.lockAndFetchWalletsTx(tx, ids);
      const destination = wallets[ids[0]];
      const systemWallet = wallets[ids[1]];

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
      const ids = await this.getWalletIds(tx, [
        { userId, ownerType },
        { ownerType: OwnerType.SYSTEM }
      ]);
      const wallets = await this.lockAndFetchWalletsTx(tx, ids);
      const source = wallets[ids[0]];
      const systemWallet = wallets[ids[1]];

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
    const ids = await this.getWalletIds(tx, [{ ownerType: OwnerType.SYSTEM }]);
    const wallets = await this.lockAndFetchWalletsTx(tx, ids);
    return wallets[ids[0]];
  }

  async findWalletTx(tx: Prisma.TransactionClient, userId: string, ownerType: OwnerType): Promise<Wallet> {
    const ids = await this.getWalletIds(tx, [{ userId, ownerType }]);
    const wallets = await this.lockAndFetchWalletsTx(tx, ids);
    return wallets[ids[0]];
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
