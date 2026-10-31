import { DomainException } from '../utils/domain.exception';
import { Request, Response } from 'express';
import { PaymentService } from '../services/payment.service';
import { WalletClient } from '../clients/wallet.client';

const walletClient = new WalletClient();
const paymentService = new PaymentService(walletClient);

// req.auth được inject bởi requireGateway (ES256 verified) từ finvault-internal-auth.
// Tất cả endpoint người dùng đều đi qua requireGateway → req.auth luôn tồn tại.

export const checkout = async (req: Request, res: Response) => {
    const userId = req.auth!.userId;
    const headerKey = req.get('Idempotency-Key');
    if (headerKey && req.body.idempotencyKey && headerKey !== req.body.idempotencyKey)
      throw new DomainException(400, 'IDEMPOTENCY_KEY_MISMATCH', 'Header and body keys differ');
    const idempotencyKey = headerKey || req.body.idempotencyKey;
    if (!idempotencyKey || idempotencyKey.length > 255) throw new DomainException(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required');
    const { payment, replayed } = await paymentService.checkout({ ...req.body, idempotencyKey, userId });
    res.status(201).json({ success: true, data: { ...payment, replayed } });
};

export const confirm = async (req: Request, res: Response) => {
    const userId = req.auth!.userId;
    const tokenPayload = req.transactionToken!;
    const result = await paymentService.confirm(req.params.id as string, userId, tokenPayload);
    res.json({ success: true, data: result });
};

export const internalConfirm = async (req: Request, res: Response) => {
    const result = await paymentService.internalConfirm(req.params.id as string);
    res.json({ success: true, data: result });
};

export const refund = async (req: Request, res: Response) => {
    // refund được gọi từ internal service (requireInternalAuth), không có req.auth
    const result = await paymentService.refund(req.params.id as string);
    res.json({ success: true, data: result });
};

export const cancel = async (req: Request, res: Response) => {
    const result = await paymentService.cancel(req.params.id as string, req.auth!.userId, req.auth!.role);
    res.json({ success: true, data: result });
};

export const getById = async (req: Request, res: Response) => {
    const result = await paymentService.getById(req.params.id as string, req.auth!.userId, req.auth!.role);
    if (!result) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Payment not found' } });
    }
    res.json({ success: true, data: result, ...result });
};

export const list = async (req: Request, res: Response) => {
    const requesterId = req.auth!.userId;
    const requesterRole = req.auth!.role;
    const { userId: queryUserId, type, status } = req.query as any;

    // Chỉ ADMIN mới được truyền userId (lọc theo user khác hoặc xem tất cả).
    // Với người dùng thông thường, luôn luôn lọc theo req.auth.userId (Mục 7).
    const targetUserId = requesterRole === 'ADMIN' ? (queryUserId || undefined) : requesterId;

    const result = await paymentService.list(targetUserId, type, status);
    res.json({ success: true, data: result });
};

export const p2pQuote = async (req: Request, res: Response) => {
    const senderId = req.auth!.userId;
    const { destinationUserId, amount } = req.body;
    const result = await paymentService.p2pQuote(senderId, destinationUserId, String(amount));
    res.json({ success: true, data: result });
};

export const p2pCheckout = async (req: Request, res: Response) => {
    const senderId = req.auth!.userId;
    const idempotencyKey = (req.headers['idempotency-key'] || req.headers['Idempotency-Key']) as string;
    const { destinationUserId, destinationOwnerType, amount, note } = req.body;

    const { payment, replayed } = await paymentService.p2pCheckout({
        senderId,
        destinationUserId,
        destinationOwnerType,
        amount,
        idempotencyKey,
        note
    });

    res.status(201).json({ success: true, data: { ...payment, replayed } });
};
