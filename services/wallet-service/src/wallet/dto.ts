import { LedgerDirection, OwnerType, TransferType } from '@prisma/client';

export interface CreateWalletDto {
  userId: number;
  ownerType?: OwnerType;
  currency?: string;
}

export interface AdjustDto {
  amount: string;
  referenceId: string;
  direction: LedgerDirection;
  reason?: string;
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

export interface HistoryQueryDto {
  ownerType?: OwnerType;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export interface ListWalletsDto {
  userId?: number;
  ownerType?: OwnerType;
  status?: string;
  page?: number;
  limit?: number;
}

export interface TransferDto {
  fromUserId: number;
  toUserId: number;
  amount: string;
  referenceId: string;
}
