const HttpStatus = { NOT_FOUND: 404, BAD_REQUEST: 400, CONFLICT: 409, INTERNAL_SERVER_ERROR: 500 };
import {
  HoldStatus,
  LedgerDirection,
  OwnerType,
  Prisma,
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

// --- MOCK DATA STORE ---
const mockWallets: Wallet[] = [];
const mockHolds: any[] = [];
const mockLedgers: any[] = [];

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
    // Đảm bảo luôn có ví SYSTEM
    if (!mockWallets.find((w) => w.ownerType === OwnerType.SYSTEM)) {
      mockWallets.push({
        id: 999999,
        userId: "0",
        ownerType: OwnerType.SYSTEM,
        balance: new Prisma.Decimal(0),
        heldBalance: new Prisma.Decimal(0),
        currency: "VND",
        status: WalletStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }

  /**
   * Tạo ví mới cho người dùng. (Mock)
   */
  async createWallet(dto: CreateWalletDto) {
    const ownerType = dto.ownerType ?? OwnerType.USER;
    if (ownerType === OwnerType.SYSTEM) {
      throw new DomainException(
        HttpStatus.BAD_REQUEST,
        "INVALID_OWNER_TYPE",
        "SYSTEM wallets are managed by wallet-service only",
      );
    }

    const existing = mockWallets.find(
      (w) => w.userId === dto.userId && w.ownerType === ownerType,
    );
    if (existing) {
      return { wallet: existing, created: false };
    }

    const wallet: Wallet = {
      id: mockWallets.length + 1,
      userId: dto.userId,
      ownerType,
      currency: dto.currency ?? "VND",
      balance: new Prisma.Decimal(0),
      heldBalance: new Prisma.Decimal(0),
      status: WalletStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockWallets.push(wallet);
    return { wallet, created: true };
  }

  /**
   * Lấy thông tin số dư của ví. (Mock)
   */
  async getBalance(userId: string, ownerType: OwnerType = OwnerType.USER) {
    return this.findWallet(userId, ownerType);
  }

  /**
   * Tạo lệnh giữ tiền. (Mock)
   */
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
      throw new DomainException(
        HttpStatus.BAD_REQUEST,
        "INVALID_HOLD_EXPIRY",
        "expiresAt must be in the future",
      );
    }

    const wallet = this.findWallet(userId, ownerType);

    const existing = mockHolds.find(
      (h) => h.walletId === wallet.id && h.referenceId === referenceId,
    );
    if (existing) {
      if (!existing.amount.eq(amount)) {
        throw this.conflict(
          "REFERENCE_ID_REUSED",
          "referenceId was used with a different amount",
        );
      }
      return { hold: existing, replayed: true };
    }

    this.assertWalletActive(wallet);
    if (wallet.balance.sub(wallet.heldBalance).lt(amount)) {
      throw this.insufficientBalance();
    }

    wallet.heldBalance = wallet.heldBalance.add(amount);

    const hold = {
      id: randomUUID(),
      walletId: wallet.id,
      amount,
      referenceId,
      expiresAt,
      status: HoldStatus.PENDING,
      transactionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockHolds.push(hold);

    return { hold, replayed: false };
  }

  /**
   * Thực thi (capture) lệnh giữ tiền. (Mock)
   */
  async captureHold(
    userId: string,
    referenceId: string,
    ownerType: OwnerType = OwnerType.USER,
  ) {
    const wallet = this.findWallet(userId, ownerType);
    const hold = mockHolds.find(
      (h) => h.walletId === wallet.id && h.referenceId === referenceId,
    );

    if (!hold)
      throw new DomainException(
        HttpStatus.NOT_FOUND,
        "HOLD_NOT_FOUND",
        "Hold was not found",
      );

    if (hold.status === HoldStatus.CAPTURED) {
      return {
        expired: false,
        balance: wallet.balance,
        transactionId: hold.transactionId,
        replayed: true,
      };
    }
    if (
      hold.status === HoldStatus.RELEASED ||
      hold.status === HoldStatus.EXPIRED
    ) {
      throw this.conflict(
        "HOLD_NOT_CAPTURABLE",
        "Hold has already been released",
      );
    }

    if (hold.expiresAt.getTime() <= Date.now()) {
      wallet.heldBalance = wallet.heldBalance.sub(hold.amount);
      hold.status = HoldStatus.EXPIRED;
      throw this.conflict("HOLD_EXPIRED", "Hold has expired and was released");
    }

    const systemWallet = this.getSystemWallet();
    const movement = this.moveMoneyTx({
      fromWallet: wallet,
      toWallet: systemWallet,
      amount: hold.amount,
      referenceId,
      transferType: TransferType.PAYMENT,
      consumeHeldFrom: true,
    });

    hold.status = HoldStatus.CAPTURED;
    hold.transactionId = movement.transactionId;

    return {
      expired: false,
      balance: movement.sourceWallet.balance,
      transactionId: movement.transactionId,
      replayed: movement.replayed,
    };
  }

  /**
   * Hủy lệnh giữ tiền. (Mock)
   */
  async releaseHold(
    userId: string,
    referenceId: string,
    ownerType: OwnerType = OwnerType.USER,
  ) {
    const wallet = this.findWallet(userId, ownerType);
    const hold = mockHolds.find(
      (h) => h.walletId === wallet.id && h.referenceId === referenceId,
    );

    if (!hold)
      throw new DomainException(
        HttpStatus.NOT_FOUND,
        "HOLD_NOT_FOUND",
        "Hold was not found",
      );
    if (hold.status === HoldStatus.CAPTURED)
      throw this.conflict(
        "HOLD_ALREADY_CAPTURED",
        "Captured holds cannot be released",
      );
    if (
      hold.status === HoldStatus.RELEASED ||
      hold.status === HoldStatus.EXPIRED
    ) {
      return { hold, replayed: true };
    }

    const status =
      hold.expiresAt.getTime() <= Date.now()
        ? HoldStatus.EXPIRED
        : HoldStatus.RELEASED;
    wallet.heldBalance = wallet.heldBalance.sub(hold.amount);
    hold.status = status;

    return { hold, replayed: false };
  }

  /**
   * Chuyển tiền từ ví này sang ví khác. (Mock)
   */
  async transfer(dto: TransferDto) {
    if (dto.fromUserId === dto.toUserId)
      throw new DomainException(
        HttpStatus.BAD_REQUEST,
        "SAME_WALLET_TRANSFER",
        "Wallets must differ",
      );
    const amount = this.money(dto.amount);
    const from = this.findWallet(dto.fromUserId, OwnerType.USER);
    const to = this.findWallet(dto.toUserId, OwnerType.USER);

    return this.moveMoneyTx({
      fromWallet: from,
      toWallet: to,
      amount,
      referenceId: dto.referenceId,
      transferType: TransferType.P2P_TRANSFER,
    });
  }

  /**
   * Nạp tiền vào ví. (Mock)
   */
  async credit(
    userId: string,
    dto: CreditDto,
    ownerType: OwnerType = OwnerType.USER,
  ) {
    console.log('CREDIT API CALLED:', { userId, type: typeof userId });
    const transferType = dto.transferType ?? TransferType.TOPUP;
    const amount = this.money(dto.amount);
    const destination = this.findWallet(userId, ownerType);
    const systemWallet = this.getSystemWallet();

    return this.moveMoneyTx({
      fromWallet: systemWallet,
      toWallet: destination,
      amount,
      referenceId: dto.referenceId,
      transferType,
    });
  }

  /**
   * Trừ tiền trực tiếp. (Mock)
   */
  async debit(
    userId: string,
    dto: DebitDto,
    ownerType: OwnerType = OwnerType.USER,
  ) {
    const transferType = dto.transferType ?? TransferType.PAYMENT;
    const amount = this.money(dto.amount);
    const source = this.findWallet(userId, ownerType);
    const systemWallet = this.getSystemWallet();

    return this.moveMoneyTx({
      fromWallet: source,
      toWallet: systemWallet,
      amount,
      referenceId: dto.referenceId,
      transferType,
    });
  }

  /**
   * Điều chỉnh số dư thủ công. (Mock)
   */
  async adjust(
    userId: string,
    dto: AdjustDto,
    ownerType: OwnerType = OwnerType.USER,
  ) {
    const amount = this.money(dto.amount);
    const userWallet = this.findWallet(userId, ownerType);
    const systemWallet = this.getSystemWallet();
    const userIsSource = dto.direction === LedgerDirection.DEBIT;

    return this.moveMoneyTx({
      fromWallet: userIsSource ? userWallet : systemWallet,
      toWallet: userIsSource ? systemWallet : userWallet,
      amount,
      referenceId: dto.referenceId,
      transferType: TransferType.ADJUSTMENT,
      note: dto.reason,
      bypassLockedFrom: userIsSource,
    });
  }

  /**
   * Khóa hoặc mở khóa ví. (Mock)
   */
  async setLock(
    userId: string,
    locked: boolean,
    ownerType: OwnerType = OwnerType.USER,
  ) {
    const wallet = this.findWallet(userId, ownerType);
    wallet.status = locked ? WalletStatus.LOCKED : WalletStatus.ACTIVE;
    return wallet;
  }

  /**
   * Lấy lịch sử biến động số dư. (Mock)
   */
  async getHistory(userId: string, query: HistoryQueryDto) {
    const ownerType = query.ownerType ?? OwnerType.USER;
    const wallet = this.findWallet(userId, ownerType);
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

    const entries = mockLedgers
      .filter(
        (l) =>
          l.walletId === wallet.id && l.createdAt >= from && l.createdAt <= to,
      )
      .sort((a, b) => b.id - a.id);

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const paginated = entries.slice((page - 1) * limit, page * limit);

    return { entries: paginated, total: entries.length, page, limit, from, to };
  }

  /**
   * Lấy danh sách ví. (Mock)
   */
  async listWallets(query: ListWalletsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    let filtered = mockWallets;
    if (query.userId)
      filtered = filtered.filter(
        (w) => w.userId === query.userId,
      );
    if (query.ownerType)
      filtered = filtered.filter((w) => w.ownerType === query.ownerType);
    if (query.status)
      filtered = filtered.filter((w) => w.status === query.status);

    const paginated = filtered.slice((page - 1) * limit, page * limit);
    return { wallets: paginated, total: filtered.length, page, limit };
  }

  /**
   * Đối soát số dư ví. (Mock)
   */
  async reconcile() {
    return mockWallets.map((w) => {
      const entries = mockLedgers.filter((l) => l.walletId === w.id);
      let ledgerBalance = new Prisma.Decimal(0);
      for (const e of entries) {
        if (e.direction === LedgerDirection.CREDIT)
          ledgerBalance = ledgerBalance.add(e.amount);
        else ledgerBalance = ledgerBalance.sub(e.amount);
      }
      return {
        walletId: w.id,
        userId: w.userId,
        ownerType: w.ownerType,
        balance: decimalToString(w.balance),
        ledgerBalance: decimalToString(ledgerBalance),
        matched: w.balance.eq(ledgerBalance),
      };
    });
  }

  async releaseExpiredHolds(limit = 100) {
    const candidates = mockHolds.filter(
      (h) =>
        h.status === HoldStatus.PENDING && h.expiresAt.getTime() < Date.now(),
    );
    let released = 0;
    for (const hold of candidates) {
      const wallet = mockWallets.find((w) => w.id === hold.walletId);
      if (wallet) {
        wallet.heldBalance = wallet.heldBalance.sub(hold.amount);
        hold.status = HoldStatus.EXPIRED;
        released++;
      }
    }
    return released;
  }

  // --- PRIVATE MOCK HELPERS ---

  private getSystemWallet(): Wallet {
    return mockWallets.find((w) => w.ownerType === OwnerType.SYSTEM)!;
  }

  private findWallet(userId: string, ownerType: OwnerType): Wallet {
    const wallet = mockWallets.find(
      (w) => w.userId === userId && w.ownerType === ownerType,
    );
    if (!wallet)
      throw new DomainException(
        HttpStatus.NOT_FOUND,
        "WALLET_NOT_FOUND",
        "Wallet was not found",
      );
    return wallet;
  }

  private moveMoneyTx(input: {
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

    // Check Replay
    const replay = mockLedgers.find(
      (l) =>
        l.walletId === fromWallet.id && l.referenceId === input.referenceId,
    );
    if (replay) {
      if (
        replay.direction !== LedgerDirection.DEBIT ||
        replay.transferType !== input.transferType ||
        !replay.amount.eq(amount)
      ) {
        throw this.conflict(
          "REFERENCE_ID_REUSED",
          "referenceId was used with a different operation",
        );
      }
      return {
        sourceWallet: fromWallet,
        destinationWallet: toWallet,
        transactionId: replay.transactionId,
        replayed: true,
      };
    }

    this.assertWalletActive(fromWallet, input.bypassLockedFrom);
    this.assertWalletActive(toWallet, false);

    if (fromWallet.currency !== toWallet.currency)
      throw this.conflict("CURRENCY_MISMATCH", "Wallet currencies must match");

    if (input.consumeHeldFrom) {
      if (fromWallet.heldBalance.lt(amount))
        throw this.conflict(
          "HOLD_BALANCE_INCONSISTENT",
          "Hold amount exceeds held balance",
        );
      fromWallet.heldBalance = fromWallet.heldBalance.sub(amount);
    } else if (
      fromWallet.ownerType !== OwnerType.SYSTEM &&
      fromWallet.balance.sub(fromWallet.heldBalance).lt(amount)
    ) {
      throw this.insufficientBalance();
    }

    fromWallet.balance = fromWallet.balance.sub(amount);
    toWallet.balance = toWallet.balance.add(amount);

    const transactionId = randomUUID();
    mockLedgers.push({
      id: mockLedgers.length + 1,
      transactionId,
      walletId: fromWallet.id,
      direction: LedgerDirection.DEBIT,
      amount,
      balanceAfter: fromWallet.balance,
      referenceId: input.referenceId,
      transferType: input.transferType,
      note: input.note,
      createdAt: new Date(),
    });
    mockLedgers.push({
      id: mockLedgers.length + 1,
      transactionId,
      walletId: toWallet.id,
      direction: LedgerDirection.CREDIT,
      amount,
      balanceAfter: toWallet.balance,
      referenceId: input.referenceId,
      transferType: input.transferType,
      note: input.note,
      createdAt: new Date(),
    });

    return {
      sourceWallet: fromWallet,
      destinationWallet: toWallet,
      transactionId,
      replayed: false,
    };
  }

  private money(value: string) {
    const amount = new Prisma.Decimal(value);
    if (!amount.isFinite() || amount.lte(0) || amount.decimalPlaces() > 2) {
      throw new DomainException(
        HttpStatus.BAD_REQUEST,
        "INVALID_AMOUNT",
        "amount must be positive and have at most 2 decimal places",
      );
    }
    return amount;
  }

  private assertWalletActive(wallet: Wallet, bypass = false) {
    if (wallet.status === WalletStatus.LOCKED && !bypass)
      throw this.conflict("WALLET_LOCKED", "Wallet is locked");
  }

  private insufficientBalance() {
    return new DomainException(
      HttpStatus.CONFLICT,
      "INSUFFICIENT_BALANCE",
      "Wallet does not have enough available balance",
    );
  }

  private conflict(code: string, message: string) {
    return new DomainException(HttpStatus.CONFLICT, code, message);
  }
}
