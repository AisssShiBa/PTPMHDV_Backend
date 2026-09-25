const HttpStatus = { NOT_FOUND: 404, BAD_REQUEST: 400, CONFLICT: 409, INTERNAL_SERVER_ERROR: 500 };
import {
  HoldStatus,
  LedgerDirection,
  OwnerType,
  Prisma,
  PrismaClient,
  TransferType,
  Wallet,
  WalletStatus,
} from "@prisma/client";
import { randomUUID } from "crypto";
import { DomainException } from "../utils/domain.exception";
import {
  AdjustDto,
  CreateWalletDto,
  CreditDto,
  DebitDto,
  HistoryQueryDto,
  ListWalletsDto,
  TransferDto,
} from "../dtos/wallet.dto";

const prisma = new PrismaClient();

export function decimalToString(value: Prisma.Decimal): string {
  return value.toFixed(2);
}

export function walletView(wallet: Wallet) {
  return {
    id: wallet.id,
    userId: wallet.userId,
    ownerType: wallet.ownerType,
    balance: decimalToString(wallet.balance),
    heldBalance: decimalToString(wallet.heldBalance),
    availableBalance: decimalToString(wallet.balance.sub(wallet.heldBalance)),
    currency: wallet.currency,
    status: wallet.status,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export class WalletService {
  constructor() {
    this.ensureSystemWallet();
  }

  private async ensureSystemWallet() {
    try {
      const existing = await prisma.wallet.findFirst({
        where: { ownerType: OwnerType.SYSTEM }
      });
      if (!existing) {
        await prisma.wallet.create({
          data: {
            userId: null,
            ownerType: OwnerType.SYSTEM,
            currency: "VND",
            status: WalletStatus.ACTIVE,
          }
        });
      }
    } catch (e) {
      console.error('Failed to create SYSTEM wallet', e);
    }
  }

  // Tạo ví nếu đã có thì trả created: false và wallet: existing về json chứ không báo lỗi.
  async createWallet(dto: CreateWalletDto) {
    const ownerType = dto.ownerType ?? OwnerType.USER;
    if (ownerType === OwnerType.SYSTEM) {
      throw new DomainException(HttpStatus.BAD_REQUEST, "INVALID_OWNER_TYPE", "SYSTEM wallets are managed by wallet-service only");
    }

    return await prisma.$transaction(async (tx) => {
      const existing = await tx.wallet.findFirst({
        where: { userId: dto.userId, ownerType }
      });
      // Không nén ra bad quest khí ví đã tồn tại điều này vẫn trả về ví nhưng trạng thái tạo là false
      if (existing) {
        return { wallet: existing, created: false };
      }

      const wallet = await tx.wallet.create({
        data: {
          userId: dto.userId,
          ownerType,
          currency: dto.currency ?? "VND",
          status: WalletStatus.ACTIVE,
        }
      });
      return { wallet, created: true };
    });
  }

  // Trước khi lấy số dư cần kiểm tra ví có tồn tại hay không.
  async getBalance(userId: string, ownerType: OwnerType = OwnerType.USER) {
    const wallet = await prisma.wallet.findFirst({
      where: { userId, ownerType }
    });
    if (!wallet) throw new DomainException(HttpStatus.NOT_FOUND, "WALLET_NOT_FOUND", "Wallet was not found");
    return wallet;
  }

  // Đặt giữ tiền tránh cho các giao dịch khác dùng quá tiền khi yêu cầu này chưa được xử lý.
  async createHold(
    userId: string,
    amountValue: string,
    referenceId: string,
    expiresAtValue: string,
    ownerType: OwnerType = OwnerType.USER,
  ) {
    const amount = this.money(amountValue);
    const expiresAt = new Date(expiresAtValue);
    if (expiresAt.getTime() <= Date.now()) {
      throw new DomainException(HttpStatus.BAD_REQUEST, "INVALID_HOLD_EXPIRY", "expiresAt must be in the future");
    }

    return await prisma.$transaction(async (tx) => {
      const wallet = await this.findWalletTx(tx, userId, ownerType);

      const existing = await tx.walletHold.findUnique({
        where: { walletId_referenceId: { walletId: wallet.id, referenceId } }
      });

      if (existing) {
        if (!existing.amount.equals(amount)) {
          throw this.conflict("REFERENCE_ID_REUSED", "referenceId was used with a different amount");
        }
        return { hold: existing, replayed: true };
      }

      this.assertWalletActive(wallet);
      if (wallet.balance.sub(wallet.heldBalance).lt(amount)) {
        throw this.insufficientBalance();
      }

      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: { heldBalance: { increment: amount } }
      });

      const hold = await tx.walletHold.create({
        data: {
          walletId: wallet.id,
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
      const wallet = await this.findWalletTx(tx, userId, ownerType);
      const hold = await tx.walletHold.findUnique({
        where: { walletId_referenceId: { walletId: wallet.id, referenceId } }
      });

      if (!hold) throw new DomainException(HttpStatus.NOT_FOUND, "HOLD_NOT_FOUND", "Hold was not found");

      if (hold.status === HoldStatus.CAPTURED) {
        return { expired: false, balance: wallet.balance, transactionId: hold.transactionId, replayed: true };
      }

      if (hold.status === HoldStatus.RELEASED || hold.status === HoldStatus.EXPIRED) {
        throw this.conflict("HOLD_NOT_CAPTURABLE", "Hold has already been released");
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
        throw this.conflict("HOLD_EXPIRED", "Hold has expired and was released");
      }

      const systemWallet = await this.getSystemWalletTx(tx);
      const movement = await this.moveMoneyTxInternal(tx, {
        fromWallet: wallet,
        toWallet: systemWallet,
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
      const wallet = await this.findWalletTx(tx, userId, ownerType);
      const hold = await tx.walletHold.findUnique({
        where: { walletId_referenceId: { walletId: wallet.id, referenceId } }
      });

      if (!hold) throw new DomainException(HttpStatus.NOT_FOUND, "HOLD_NOT_FOUND", "Hold was not found");
      if (hold.status === HoldStatus.CAPTURED) throw this.conflict("HOLD_ALREADY_CAPTURED", "Captured holds cannot be released");
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

  async transfer(dto: TransferDto) {
    if (dto.fromUserId === dto.toUserId) throw new DomainException(HttpStatus.BAD_REQUEST, "SAME_WALLET_TRANSFER", "Wallets must differ");
    const amount = this.money(dto.amount);

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
    const amount = this.money(dto.amount);

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
    const amount = this.money(dto.amount);

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

  async adjust(userId: string, dto: AdjustDto, ownerType: OwnerType = OwnerType.USER) {
    const amount = this.money(dto.amount);
    const userIsSource = dto.direction === LedgerDirection.DEBIT;

    return await prisma.$transaction(async (tx) => {
      const userWallet = await this.findWalletTx(tx, userId, ownerType);
      const systemWallet = await this.getSystemWalletTx(tx);

      return await this.moveMoneyTxInternal(tx, {
        fromWallet: userIsSource ? userWallet : systemWallet,
        toWallet: userIsSource ? systemWallet : userWallet,
        amount,
        referenceId: dto.referenceId,
        transferType: TransferType.ADJUSTMENT,
        note: dto.reason,
        bypassLockedFrom: userIsSource,
      });
    });
  }

  async setLock(userId: string, locked: boolean, ownerType: OwnerType = OwnerType.USER) {
    const status = locked ? WalletStatus.LOCKED : WalletStatus.ACTIVE;
    const wallet = await prisma.wallet.findFirst({ where: { userId, ownerType } });
    if (!wallet) throw new DomainException(HttpStatus.NOT_FOUND, "WALLET_NOT_FOUND", "Wallet was not found");

    return await prisma.wallet.update({
      where: { id: wallet.id },
      data: { status }
    });
  }

  async getHistory(userId: string, query: HistoryQueryDto) {
    const ownerType = query.ownerType ?? OwnerType.USER;
    const wallet = await prisma.wallet.findFirst({ where: { userId, ownerType } });
    if (!wallet) throw new DomainException(HttpStatus.NOT_FOUND, "WALLET_NOT_FOUND", "Wallet was not found");

    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [entries, total] = await Promise.all([
      prisma.ledgerEntry.findMany({
        where: {
          walletId: wallet.id,
          createdAt: { gte: from, lte: to }
        },
        orderBy: { id: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.ledgerEntry.count({
        where: {
          walletId: wallet.id,
          createdAt: { gte: from, lte: to }
        }
      })
    ]);

    const serializedEntries = entries.map(e => ({
      ...e,
      id: e.id.toString(),
    }));

    return { entries: serializedEntries, total, page, limit, from, to };
  }

  async listWallets(query: ListWalletsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: any = {};
    if (query.userId) where.userId = query.userId;
    if (query.ownerType) where.ownerType = query.ownerType;
    if (query.status) where.status = query.status;

    const [wallets, total] = await Promise.all([
      prisma.wallet.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.wallet.count({ where })
    ]);

    return { wallets, total, page, limit };
  }

  // Đang phát triển thêm.
  async reconcile() {
    throw new DomainException(HttpStatus.INTERNAL_SERVER_ERROR, "NOT_IMPLEMENTED", "Reconciliation with real DB requires batch aggregation");
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
          const currentHold = await tx.walletHold.findUnique({ where: { id: hold.id } });
          if (currentHold && currentHold.status === HoldStatus.PENDING) {
            await tx.wallet.update({
              where: { id: hold.walletId },
              data: { heldBalance: { decrement: hold.amount } }
            });
            await tx.walletHold.update({
              where: { id: hold.id },
              data: { status: HoldStatus.EXPIRED }
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

  // --- PRIVATE HELPERS ---

  private async getSystemWalletTx(tx: any): Promise<Wallet> {
    const wallet = await tx.wallet.findFirst({ where: { ownerType: OwnerType.SYSTEM } });
    if (!wallet) throw new DomainException(HttpStatus.INTERNAL_SERVER_ERROR, "SYSTEM_WALLET_NOT_FOUND", "System wallet missing");
    return wallet;
  }

  private async findWalletTx(tx: any, userId: string, ownerType: OwnerType): Promise<Wallet> {
    const wallet = await tx.wallet.findFirst({ where: { userId, ownerType } });
    if (!wallet) throw new DomainException(HttpStatus.NOT_FOUND, "WALLET_NOT_FOUND", "Wallet was not found");
    return wallet;
  }

  // Replay được áp dụng nếu bạn cố tình lấy một cái referenceId cũ đã từng giao dịch thành công để thực hiện
  // một giao dịch với nội dung khác.
  // - Mạng bị lag, user ấn 2 lần.
  // - Bạn dùng lại referenceId cho mục đích khác.
  private async moveMoneyTxInternal(tx: any, input: {
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
        throw this.conflict("REFERENCE_ID_REUSED", "referenceId was used with a different operation");
      }

      const toWalletDb = await tx.wallet.findUnique({ where: { id: toWallet.id } });
      const fromWalletDb = await tx.wallet.findUnique({ where: { id: fromWallet.id } });

      return {
        sourceWallet: fromWalletDb,
        destinationWallet: toWalletDb,
        transactionId: replay.transactionId,
        replayed: true,
      };
    }

    this.assertWalletActive(fromWallet, input.bypassLockedFrom);
    this.assertWalletActive(toWallet, false);

    if (fromWallet.currency !== toWallet.currency) throw this.conflict("CURRENCY_MISMATCH", "Wallet currencies must match");

    if (input.consumeHeldFrom) {
      if (fromWallet.heldBalance.lt(amount)) throw this.conflict("HOLD_BALANCE_INCONSISTENT", "Hold amount exceeds held balance");
      await tx.wallet.update({
        where: { id: fromWallet.id },
        data: { heldBalance: { decrement: amount } }
      });
    } else if (fromWallet.ownerType !== OwnerType.SYSTEM && fromWallet.balance.sub(fromWallet.heldBalance).lt(amount)) {
      throw this.insufficientBalance();
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

  private money(value: string) {
    const amount = new Prisma.Decimal(value);
    if (!amount.isFinite() || amount.lte(0) || amount.decimalPlaces() > 2) {
      throw new DomainException(HttpStatus.BAD_REQUEST, "INVALID_AMOUNT", "amount must be positive and have at most 2 decimal places");
    }
    return amount;
  }

  private assertWalletActive(wallet: Wallet, bypass = false) {
    if (wallet.status === WalletStatus.LOCKED && !bypass) throw this.conflict("WALLET_LOCKED", "Wallet is locked");
  }

  private insufficientBalance() {
    return new DomainException(HttpStatus.CONFLICT, "INSUFFICIENT_BALANCE", "Wallet does not have enough available balance");
  }

  private conflict(code: string, message: string) {
    return new DomainException(HttpStatus.CONFLICT, code, message);
  }
}
