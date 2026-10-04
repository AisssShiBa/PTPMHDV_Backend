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

    let ipAddr = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';
    if (typeof ipAddr !== 'string' || ipAddr.includes(':')) {
      ipAddr = '127.0.0.1'; // VNPAY sandbox often rejects IPv6
    }

    const result = await topupService.createTopup(userId, amount, ipAddr as string);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const vnpayIpn = async (req: RequestWithContext, res: Response, next: NextFunction) => {
  try {
    const result = await topupService.handleVnpayIpn(req.query);
    res.status(200).json(result);
  } catch (error) {
    // According to VNPAY specs, on unexpected error we should return 99
    res.status(200).json({ RspCode: '99', Message: 'Unknown error' });
  }
};

export const vnpayReturn = async (req: RequestWithContext, res: Response, next: NextFunction) => {
  try {
    const result = await topupService.handleVnpayReturn(req.query);
    res.status(200).json({ success: true, data: result });
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
