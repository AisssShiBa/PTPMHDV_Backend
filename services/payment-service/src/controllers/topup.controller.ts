import { Response, NextFunction } from 'express';
import { RequestWithContext } from '../middlewares/requestId';
import { TopupService } from '../services/topup.service';
import { DomainException } from '../utils/domain.exception';

const topupService = new TopupService();

export const createTopup = async (req: RequestWithContext, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId;
    if (!userId) throw new DomainException(401, 'UNAUTHORIZED', 'Missing user context');
    const { amount } = req.body;

    const result = await topupService.createTopup(userId, amount);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const getTopup = async (req: RequestWithContext, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId;
    if (!userId) throw new DomainException(401, 'UNAUTHORIZED', 'Missing user context');
    const id = req.params.id as string;

    const result = await topupService.getTopup(id, userId);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const getMyTopups = async (req: RequestWithContext, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId;
    if (!userId) throw new DomainException(401, 'UNAUTHORIZED', 'Missing user context');

    const result = await topupService.getMyTopups(userId);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const getAdminTopups = async (req: RequestWithContext, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as string;
    const result = await topupService.getAdminTopups(status);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const approveTopup = async (req: RequestWithContext, res: Response, next: NextFunction) => {
  try {
    const adminId = req.userId;
    if (!adminId) throw new DomainException(401, 'UNAUTHORIZED', 'Missing admin context');
    const id = req.params.id as string;

    await topupService.approveTopup(id, adminId);
    res.status(200).json({ success: true, message: 'Topup approved and credited successfully' });
  } catch (error) {
    next(error);
  }
};

export const rejectTopup = async (req: RequestWithContext, res: Response, next: NextFunction) => {
  try {
    const adminId = req.userId;
    if (!adminId) throw new DomainException(401, 'UNAUTHORIZED', 'Missing admin context');
    const id = req.params.id as string;
    const { reason } = req.body;

    await topupService.rejectTopup(id, adminId, reason);
    res.status(200).json({ success: true, message: 'Topup rejected' });
  } catch (error) {
    next(error);
  }
};
