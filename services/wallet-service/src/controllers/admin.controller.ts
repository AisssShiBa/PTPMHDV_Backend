import { Request, Response } from 'express';
import { WalletService } from '../services/wallet.service';
import { LedgerService } from '../services/ledger.service';
import { WalletAdminService } from '../services/wallet-admin.service';
import { walletView } from '../utils/wallet.helpers';
import { OwnerType } from '@prisma/client';

const walletService = new WalletService();
const ledgerService = new LedgerService();
const walletAdminService = new WalletAdminService(ledgerService);

export const lock = async (req: Request, res: Response) => {
  const userId = req.params.userId;
  const ownerType = (req.query.ownerType as OwnerType) || OwnerType.USER;
  const wallet = await walletAdminService.setLock(userId, true, ownerType);
  res.json({ success: true, data: walletView(wallet) });
};

export const unlock = async (req: Request, res: Response) => {
  const userId = req.params.userId;
  const ownerType = (req.query.ownerType as OwnerType) || OwnerType.USER;
  const wallet = await walletAdminService.setLock(userId, false, ownerType);
  res.json({ success: true, data: walletView(wallet) });
};

export const adjust = async (req: Request, res: Response) => {
  const userId = req.params.userId;
  const ownerType = (req.query.ownerType as OwnerType) || OwnerType.USER;
  const result = await walletAdminService.adjust(userId, req.body, ownerType);
  res.json({ success: true, data: {
    userWallet: walletView(
      result.sourceWallet.userId === userId ? result.sourceWallet : result.destinationWallet
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
  res.json({ success: true, data: { discrepancies: rows.filter((row: any) => !row.matched), checked: rows.length } });
};
