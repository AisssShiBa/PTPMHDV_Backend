import { Prisma, Wallet, WalletStatus } from "@prisma/client";
import { DomainException } from "./domain.exception";

const HttpStatus = { NOT_FOUND: 404, BAD_REQUEST: 400, CONFLICT: 409, INTERNAL_SERVER_ERROR: 500 };

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

export function money(value: string) {
  const amount = new Prisma.Decimal(value);
  if (!amount.isFinite() || amount.lte(0) || amount.decimalPlaces() > 2) {
    throw new DomainException(HttpStatus.BAD_REQUEST, "INVALID_AMOUNT", "amount must be positive and have at most 2 decimal places");
  }
  return amount;
}

export function conflict(code: string, message: string) {
  return new DomainException(HttpStatus.CONFLICT, code, message);
}

export function insufficientBalance() {
  return new DomainException(HttpStatus.CONFLICT, "INSUFFICIENT_BALANCE", "Wallet does not have enough available balance");
}

export function assertWalletActive(wallet: Wallet, bypass = false) {
  if (wallet.status === WalletStatus.LOCKED && !bypass) throw conflict("WALLET_LOCKED", "Wallet is locked");
}
