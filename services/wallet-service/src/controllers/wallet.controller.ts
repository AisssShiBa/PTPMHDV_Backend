import { Request, Response } from 'express';
import { WalletService } from '../services/wallet.service';
import { LedgerService } from '../services/ledger.service';
import { WalletHoldService } from '../services/wallet-hold.service';
import { LimitService } from '../services/limit.service';
import { decimalToString, walletView } from '../utils/wallet.helpers';
import { OwnerType, TransferType, LedgerDirection } from '@prisma/client';
import { DomainException } from '../utils/domain.exception';

const walletService = new WalletService();
const ledgerService = new LedgerService();
const walletHoldService = new WalletHoldService(ledgerService);
const limitService = new LimitService();

export const create = async (req: Request, res: Response) => {
  const result = await walletService.createWallet(req.body);
  res.status(result.created ? 201 : 200).json({ success: true, data: { ...walletView(result.wallet), created: result.created } });
};

export const getMe = async (req: Request, res: Response) => {
  const auth = (req as any).auth;
  if (!auth?.userId) {
    console.warn(JSON.stringify({
      route: '/me',
      errorCode: 'UNAUTHORIZED',
      message: 'Missing authentication context',
    }));
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing authentication context' },
    });
  }

  try {
    const wallet = await walletService.getBalance(auth.userId, OwnerType.USER);
    const kycTier = typeof auth.kycTier === 'number' ? auth.kycTier : (wallet.kycTier ?? 0);
    const limitInfo = await limitService.getUsageAndLimits(auth.userId, kycTier);

    return res.json({
      success: true,
      data: {
        id: wallet.id,
        userId: wallet.userId,
        balance: decimalToString(wallet.balance),
        heldBalance: decimalToString(wallet.heldBalance),
        availableBalance: decimalToString(wallet.balance.sub(wallet.heldBalance)),
        currency: wallet.currency,
        status: wallet.status,
        kycTier,
        dailyLimit: limitInfo ? limitInfo.dailyLimit : undefined,
        dailyUsed: limitInfo ? limitInfo.dailyUsed : undefined,
        monthlyLimit: limitInfo ? limitInfo.monthlyLimit : undefined,
        monthlyUsed: limitInfo ? limitInfo.monthlyUsed : undefined,
        createdAt: wallet.createdAt.toISOString(),
        updatedAt: wallet.updatedAt.toISOString(),
      },
    });
  } catch (err: any) {
    console.warn(JSON.stringify({
      route: '/me',
      userId: auth.userId,
      errorCode: err.code || 'UNKNOWN_ERROR',
      message: err.message,
    }));
    throw err;
  }
};

function parseStartDate(raw: unknown): Date | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const str = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const d = new Date(`${str}T00:00:00.000+07:00`);
    if (isNaN(d.getTime())) {
      throw new DomainException(400, 'INVALID_DATE_FORMAT', 'startDate không đúng định dạng YYYY-MM-DD hoặc ISO-8601');
    }
    return d;
  }
  const d = new Date(str);
  if (isNaN(d.getTime())) {
    throw new DomainException(400, 'INVALID_DATE_FORMAT', 'startDate không đúng định dạng YYYY-MM-DD hoặc ISO-8601');
  }
  return d;
}

function parseEndDate(raw: unknown): Date | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const str = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const d = new Date(`${str}T23:59:59.999+07:00`);
    if (isNaN(d.getTime())) {
      throw new DomainException(400, 'INVALID_DATE_FORMAT', 'endDate không đúng định dạng YYYY-MM-DD hoặc ISO-8601');
    }
    return d;
  }
  const d = new Date(str);
  if (isNaN(d.getTime())) {
    throw new DomainException(400, 'INVALID_DATE_FORMAT', 'endDate không đúng định dạng YYYY-MM-DD hoặc ISO-8601');
  }
  return d;
}

function parseTransferType(raw: unknown): TransferType | 'WITHDRAW' | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const upper = raw.trim().toUpperCase();
  if (upper === 'ALL') return undefined;
  if (upper === 'TRANSFER' || upper === 'P2P_TRANSFER') {
    return TransferType.P2P_TRANSFER;
  }
  if (upper === 'WITHDRAW') {
    return 'WITHDRAW';
  }
  if (Object.values(TransferType).includes(upper as TransferType)) {
    return upper as TransferType;
  }
  throw new DomainException(400, 'INVALID_TYPE', `Loại giao dịch không hợp lệ: ${raw}`);
}

function parseDirection(raw: unknown): LedgerDirection | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const upper = raw.trim().toUpperCase();
  if (upper === 'ALL') return undefined;
  if (upper === 'CREDIT' || upper === 'IN') return LedgerDirection.CREDIT;
  if (upper === 'DEBIT' || upper === 'OUT') return LedgerDirection.DEBIT;
  throw new DomainException(400, 'INVALID_DIRECTION', 'Direction phải là CREDIT hoặc DEBIT');
}

export const getMeLedger = async (req: Request, res: Response) => {
  const auth = (req as any).auth;
  if (!auth?.userId) {
    console.warn(JSON.stringify({
      route: '/me/ledger',
      errorCode: 'UNAUTHORIZED',
      message: 'Missing authentication context',
    }));
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing authentication context' },
    });
  }

  let limit = 20;
  if (req.query.limit !== undefined) {
    const rawLimit = Number(req.query.limit);
    if (!Number.isInteger(rawLimit) || rawLimit <= 0) {
      console.warn(JSON.stringify({
        route: '/me/ledger',
        userId: auth.userId,
        errorCode: 'INVALID_LIMIT',
        message: 'Limit must be a positive integer',
      }));
      throw new DomainException(400, 'INVALID_LIMIT', 'Limit phải là số nguyên dương');
    }
    limit = Math.min(rawLimit, 100);
  }

  const cursor = typeof req.query.cursor === 'string' && req.query.cursor.trim() !== ''
    ? req.query.cursor.trim()
    : undefined;

  const startDate = parseStartDate(req.query.startDate);
  const endDate = parseEndDate(req.query.endDate);
  if (startDate && endDate && startDate.getTime() > endDate.getTime()) {
    throw new DomainException(400, 'INVALID_DATE_RANGE', 'startDate không thể lớn hơn endDate');
  }

  const type = parseTransferType(req.query.type);
  const direction = parseDirection(req.query.direction);

  try {
    const result = await walletService.getMeLedger(auth.userId, {
      cursor,
      limit,
      startDate,
      endDate,
      type,
      direction,
    });
    return res.json({
      success: true,
      data: result,
    });
  } catch (err: any) {
    console.warn(JSON.stringify({
      route: '/me/ledger',
      userId: auth.userId,
      errorCode: err.code || 'UNKNOWN_ERROR',
      message: err.message,
    }));
    throw err;
  }
};

export const getBalance = async (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  const ownerType = (req.query.ownerType as string as OwnerType) || OwnerType.USER;
  const systemCode = req.query.systemCode as any;
  const wallet = await walletService.getBalance(userId, ownerType, systemCode);
  res.json({
    success: true, data: {
      balance: decimalToString(wallet.balance),
      heldBalance: decimalToString(wallet.heldBalance),
      availableBalance: decimalToString(wallet.balance.sub(wallet.heldBalance)),
      currency: wallet.currency,
      status: wallet.status,
    }
  });
};

export const hold = async (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  const ownerType = (req.query.ownerType as string as OwnerType) || OwnerType.USER;
  const { amount, referenceId, expiresAt, destinationUserId, destinationOwnerType } = req.body;

  const { hold, replayed } = await walletHoldService.createHold(
    userId, amount, referenceId, expiresAt, ownerType, 
    destinationUserId, destinationOwnerType || OwnerType.USER
  );
  res.json({
    success: true, data: {
      id: hold.id,
      amount: decimalToString(hold.amount),
      referenceId: hold.referenceId,
      status: hold.status,
      expiresAt: hold.expiresAt.toISOString(),
      replayed,
    }
  });
};

export const extend = async (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  const ownerType = (req.query.ownerType as string as OwnerType) || OwnerType.USER;
  const { referenceId, expiresAt } = req.body;
  const { hold, replayed, extended } = await walletHoldService.extendHold(userId, referenceId, expiresAt, ownerType);
  res.json({
    success: true, data: {
      id: hold.id,
      status: hold.status,
      expiresAt: hold.expiresAt.toISOString(),
      replayed,
      extended,
    }
  });
};

export const capture = async (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  const ownerType = (req.query.ownerType as string as OwnerType) || OwnerType.USER;
  const { referenceId } = req.body;
  const result = await walletHoldService.captureHold(userId, referenceId, ownerType);
  res.json({
    success: true, data: {
      balance: decimalToString(result.balance),
      transactionId: result.transactionId,
      replayed: result.replayed,
    }
  });
};

export const release = async (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  const ownerType = (req.query.ownerType as string as OwnerType) || OwnerType.USER;
  const { referenceId } = req.body;
  const { hold, replayed } = await walletHoldService.releaseHold(userId, referenceId, ownerType);
  res.json({ success: true, data: { id: hold.id, status: hold.status, replayed } });
};

export const transfer = async (req: Request, res: Response) => {
  const fromUserId = req.params.userId as string;
  const result = await ledgerService.transfer({ fromUserId, ...req.body });
  res.json({
    success: true, data: {
      fromBalance: decimalToString(result.sourceWallet.balance),
      toBalance: decimalToString(result.destinationWallet.balance),
      transactionId: result.transactionId,
      replayed: result.replayed,
    }
  });
};

export const credit = async (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  const ownerType = (req.query.ownerType as string as OwnerType) || OwnerType.USER;
  const result = await ledgerService.credit(userId, req.body, ownerType);
  res.json({
    success: true, data: {
      balance: decimalToString(result.destinationWallet.balance),
      transactionId: result.transactionId,
      replayed: result.replayed,
    }
  });
};

export const debit = async (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  const ownerType = (req.query.ownerType as string as OwnerType) || OwnerType.USER;
  const result = await ledgerService.debit(userId, req.body, ownerType);
  res.json({
    success: true, data: {
      balance: decimalToString(result.sourceWallet.balance),
      transactionId: result.transactionId,
      replayed: result.replayed,
    }
  });
};

export const history = async (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  const query: any = req.query;
  const result = await walletService.getHistory(userId, query);
  res.json({
    success: true, data: {
      items: result.entries.map((entry: any) => ({
        id: entry.id.toString(),
        transactionId: entry.transactionId,
        direction: entry.direction,
        amount: decimalToString(entry.amount),
        balanceAfter: decimalToString(entry.balanceAfter),
        referenceId: entry.referenceId,
        transferType: entry.transferType,
        note: entry.note,
        createdAt: entry.createdAt.toISOString(),
      })),
      total: result.total,
      page: result.page,
      limit: result.limit,
      from: result.from.toISOString(),
      to: result.to.toISOString(),
    }
  });
};

export const refund = async (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  const ownerType = (req.query.ownerType as string as OwnerType) || OwnerType.USER;
  const { referenceId, originalReferenceId, amount } = req.body;
  const result = await walletHoldService.refundCapture(userId, { referenceId, originalReferenceId, amount }, ownerType);
  res.json({
    success: true,
    data: result,
  });
};

export const lookupTransaction = async (req: Request, res: Response) => {
  const referenceId = req.query.referenceId as string;
  if (!referenceId) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_INPUT', message: 'referenceId query param is required' },
    });
  }
  const result = await ledgerService.lookupByReferenceId(referenceId);
  res.json({ success: true, data: result });
};
