import { Request, Response } from 'express';
import { WalletService, decimalToString, walletView } from '../wallet/wallet.service';
import { OwnerType } from '@prisma/client';

const walletService = new WalletService();

export const create = async (req: Request, res: Response) => {
  const result = await walletService.createWallet(req.body);
  res.status(result.created ? 201 : 200).json({ success: true, data: { ...walletView(result.wallet), created: result.created } });
};

export const getBalance = async (req: Request, res: Response) => {
  const userId = req.params.userId;
  const ownerType = (req.query.ownerType as OwnerType) || OwnerType.USER;
  const wallet = await walletService.getBalance(Number(userId), ownerType);
  res.json({ success: true, data: {
    balance: decimalToString(wallet.balance),
    heldBalance: decimalToString(wallet.heldBalance),
    availableBalance: decimalToString(wallet.balance.sub(wallet.heldBalance)),
    currency: wallet.currency,
    status: wallet.status,
  } });
};

export const hold = async (req: Request, res: Response) => {
  const userId = req.params.userId;
  const ownerType = (req.query.ownerType as OwnerType) || OwnerType.USER;
  const { amount, referenceId, expiresAt } = req.body;
  const { hold, replayed } = await walletService.createHold(Number(userId), amount, referenceId, expiresAt, ownerType);
  res.json({ success: true, data: {
    id: hold.id,
    amount: decimalToString(hold.amount),
    referenceId: hold.referenceId,
    status: hold.status,
    expiresAt: hold.expiresAt.toISOString(),
    replayed,
  } });
};

export const capture = async (req: Request, res: Response) => {
  const userId = req.params.userId;
  const ownerType = (req.query.ownerType as OwnerType) || OwnerType.USER;
  const { referenceId } = req.body;
  const result = await walletService.captureHold(Number(userId), referenceId, ownerType);
  res.json({ success: true, data: {
    balance: decimalToString(result.balance),
    transactionId: result.transactionId,
    replayed: result.replayed,
  } });
};

export const release = async (req: Request, res: Response) => {
  const userId = req.params.userId;
  const ownerType = (req.query.ownerType as OwnerType) || OwnerType.USER;
  const { referenceId } = req.body;
  const { hold, replayed } = await walletService.releaseHold(Number(userId), referenceId, ownerType);
  res.json({ success: true, data: { id: hold.id, status: hold.status, replayed } });
};

export const transfer = async (req: Request, res: Response) => {
  const result = await walletService.transfer(req.body);
  res.json({ success: true, data: {
    fromBalance: decimalToString(result.sourceWallet.balance),
    toBalance: decimalToString(result.destinationWallet.balance),
    transactionId: result.transactionId,
    replayed: result.replayed,
  } });
};

export const credit = async (req: Request, res: Response) => {
  const userId = req.params.userId;
  const ownerType = (req.query.ownerType as OwnerType) || OwnerType.USER;
  const result = await walletService.credit(Number(userId), req.body, ownerType);
  res.json({ success: true, data: {
    balance: decimalToString(result.destinationWallet.balance),
    transactionId: result.transactionId,
    replayed: result.replayed,
  } });
};

export const debit = async (req: Request, res: Response) => {
  const userId = req.params.userId;
  const ownerType = (req.query.ownerType as OwnerType) || OwnerType.USER;
  const result = await walletService.debit(Number(userId), req.body, ownerType);
  res.json({ success: true, data: {
    balance: decimalToString(result.sourceWallet.balance),
    transactionId: result.transactionId,
    replayed: result.replayed,
  } });
};

export const history = async (req: Request, res: Response) => {
  const userId = req.params.userId;
  const query: any = req.query;
  const result = await walletService.getHistory(Number(userId), query);
  res.json({ success: true, data: {
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
  } });
};
