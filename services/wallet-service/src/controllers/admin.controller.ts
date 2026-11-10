import { Request, Response } from 'express';
import { WalletService } from '../services/wallet.service';
import { LedgerService } from '../services/ledger.service';
import { WalletAdminService } from '../services/wallet-admin.service';
import { ReconciliationService } from '../services/reconciliation.service';
import { walletView } from '../utils/wallet.helpers';
import { OwnerType } from '@prisma/client';

const walletService = new WalletService();
const ledgerService = new LedgerService();
const walletAdminService = new WalletAdminService(ledgerService);
const reconciliationService = new ReconciliationService();

export const lock = async (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  const ownerType = (req.query.ownerType as string as OwnerType) || OwnerType.USER;
  const wallet = await walletAdminService.setLock(userId, true, ownerType);
  res.json({ success: true, data: walletView(wallet) });
};

export const unlock = async (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  const ownerType = (req.query.ownerType as string as OwnerType) || OwnerType.USER;
  const wallet = await walletAdminService.setLock(userId, false, ownerType);
  res.json({ success: true, data: walletView(wallet) });
};

export const adjust = async (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  const ownerType = (req.query.ownerType as string as OwnerType) || OwnerType.USER;
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
  let mode: 'quick' | 'full' = 'quick';
  if (req.query.mode !== undefined) {
    const qMode = String(req.query.mode).toLowerCase();
    if (qMode !== 'quick' && qMode !== 'full') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_MODE',
          message: "mode must be 'quick' or 'full'",
        },
      });
    }
    mode = qMode as 'quick' | 'full';
  } else if (req.query.isFull === 'true') {
    mode = 'full';
  }

  const report = await reconciliationService.runReconciliation(mode);
  return res.json({ 
    success: true, 
    data: report 
  });
};

export const listReports = async (req: Request, res: Response) => {
  const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  const page = req.query.page ? Number(req.query.page) : undefined;
  const includeAnomalies = req.query.includeAnomalies === 'true';

  const result = await reconciliationService.listReports({
    cursor,
    limit,
    page,
    includeAnomalies,
  });

  return res.json({
    success: true,
    data: result,
  });
};
