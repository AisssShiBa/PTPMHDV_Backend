import { Request, Response } from 'express';
import { WalletService, walletView } from '../wallet/wallet.service';
import { OwnerType } from '@prisma/client';

const walletService = new WalletService();

export const lock = async (req: Request, res: Response) => {
  const userId = req.params.userId;
  const ownerType = (req.query.ownerType as OwnerType) || OwnerType.USER;
  const wallet = await walletService.setLock(Number(userId), true, ownerType);
  res.json({ success: true, data: walletView(wallet) });
};

export const unlock = async (req: Request, res: Response) => {
  const userId = req.params.userId;
  const ownerType = (req.query.ownerType as OwnerType) || OwnerType.USER;
  const wallet = await walletService.setLock(Number(userId), false, ownerType);
  res.json({ success: true, data: walletView(wallet) });
};

export const adjust = async (req: Request, res: Response) => {
  const userId = req.params.userId;
  const ownerType = (req.query.ownerType as OwnerType) || OwnerType.USER;
  const result = await walletService.adjust(Number(userId), req.body, ownerType);
  res.json({ success: true, data: {
    userWallet: walletView(
      result.sourceWallet.userId === Number(userId) ? result.sourceWallet : result.destinationWallet
    ),
    transactionId: result.transactionId,
    replayed: result.replayed
  } });
};

export const list = async (req: Request, res: Response) => {
  const result = await walletService.listWallets(req.query as any);
  res.json({ success: true, data: {
    items: result.wallets.map(walletView),
    total: result.total,
    page: result.page,
    limit: result.limit
  } });
};

export const reconciliation = async (req: Request, res: Response) => {
  const rows = await walletService.reconcile();
  res.json({ success: true, data: { discrepancies: rows.filter((row) => !row.matched), checked: rows.length } });
};
