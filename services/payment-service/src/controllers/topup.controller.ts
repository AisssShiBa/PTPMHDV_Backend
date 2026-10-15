import { Request, Response, NextFunction } from 'express';
import { TopupService } from '../services/topup.service';
import { DomainException } from '../utils/domain.exception';

const topupService = new TopupService();

// Lưu ý: Tất cả các hàm dưới đây (trừ vnpayIpn/vnpayReturn) đều đi qua requireGateway.
// userId lấy từ req.auth.userId (ES256 verified), không từ header x-user-id.

export const createTopup = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.auth!.userId;   // ← từ req.auth (finvault-internal-auth)
        const { amount } = req.body;

        let ipAddr = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';
        if (typeof ipAddr !== 'string' || ipAddr.includes(':')) {
            ipAddr = '127.0.0.1'; // VNPAY sandbox thường reject IPv6
        }

        const result = await topupService.createTopup(userId, amount, ipAddr as string);
        res.status(201).json({ success: true, data: result });
    } catch (error) {
        next(error);
    }
};

export const vnpayIpn = async (req: Request, res: Response, next: NextFunction) => {
    try {
        // Route công khai — không có req.auth.
        // Bảo vệ bằng HMAC checksum của VNPay trong topupService.handleVnpayIpn.
        const result = await topupService.handleVnpayIpn(req.query);
        res.status(200).json(result);
    } catch (error) {
        // Theo spec VNPay, lỗi không mong muốn phải trả về RspCode: '99'
        res.status(200).json({ RspCode: '99', Message: 'Unknown error' });
    }
};

export const vnpayReturn = async (req: Request, res: Response, next: NextFunction) => {
    try {
        // Route công khai — không có req.auth.
        const result = await topupService.handleVnpayReturn(req.query);
        res.status(200).json({ success: true, data: result });
    } catch (error) {
        next(error);
    }
};

export const getTopup = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.auth!.userId;   // ← từ req.auth
        const id = req.params.id as string;

        const result = await topupService.getTopup(id, userId);
        res.status(200).json({ success: true, data: result });
    } catch (error) {
        next(error);
    }
};

export const getMyTopups = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const userId = req.auth!.userId;   // ← từ req.auth
        const result = await topupService.getMyTopups(userId);
        res.status(200).json({ success: true, data: result });
    } catch (error) {
        next(error);
    }
};

export const getAdminTopups = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const status = req.query.status as string;
        const result = await topupService.getAdminTopups(status);
        res.status(200).json({ success: true, data: result });
    } catch (error) {
        next(error);
    }
};

export const approveTopup = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const adminId = req.auth!.userId;  // ← từ req.auth (đã verify là ADMIN qua requireRole)
        const id = req.params.id as string;

        await topupService.approveTopup(id, adminId);
        res.status(200).json({ success: true, message: 'Topup approved and credited successfully' });
    } catch (error) {
        next(error);
    }
};

export const rejectTopup = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const adminId = req.auth!.userId;  // ← từ req.auth
        const id = req.params.id as string;
        const { reason } = req.body;

        await topupService.rejectTopup(id, adminId, reason);
        res.status(200).json({ success: true, message: 'Topup rejected' });
    } catch (error) {
        next(error);
    }
};
