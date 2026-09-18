import { LedgerDirection, OwnerType, TransferType } from '@prisma/client';

export interface CreateWalletDto {
  userId: string;
  ownerType?: OwnerType;
  currency?: string;
}

export interface CreditDto {
  amount: string;
  referenceId: string;
  transferType?: TransferType;
}

export interface DebitDto {
  amount: string;
  referenceId: string;
  transferType?: TransferType;
}

export interface TransferDto {
  fromUserId: string;
  toUserId: string;
  amount: string;
  referenceId: string;
}

export interface AdjustDto {
  amount: string;
  direction: LedgerDirection;
  referenceId: string;
  reason: string;
}

export interface HistoryQueryDto {
  ownerType?: OwnerType;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export interface ListWalletsDto {
  userId?: string;
  ownerType?: OwnerType;
  status?: string;
  page?: number;
  limit?: number;
}
