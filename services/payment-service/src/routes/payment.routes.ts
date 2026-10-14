import { Router } from 'express';
import { requireGateway } from 'finvault-internal-auth';      // ← từ package chung
import { requireInternalAuth } from '../middlewares/internalAuth';
import { attachRequestId } from '../middlewares/requestId';
import { validate } from '../middlewares/validate';
import * as paymentController from '../controllers/payment.controller';
import * as schemas from '../validations/payment.validation';
import topupRoutes from './topup.routes';
import adminTopupRoutes from './admin-topup.routes';

const router = Router();

router.use('/topups', topupRoutes);
router.use('/admin/topups', adminTopupRoutes);

// Routes yêu cầu user đã đăng nhập (qua Gateway, ES256 verified)
router.post('/checkout', requireGateway, attachRequestId, validate(schemas.checkoutSchema), paymentController.checkout);
router.post('/:id/cancel', requireGateway, attachRequestId, validate(schemas.paramIdSchema), paymentController.cancel);
router.get('/:id',         requireGateway, attachRequestId, validate(schemas.paramIdSchema), paymentController.getById);
router.get('/',            requireGateway, attachRequestId, validate(schemas.paginationSchema), paymentController.list);

// confirm và refund được gọi từ service nội bộ (VD: sau khi xử lý payment workflow),
// không có user context → xác thực bằng INTERNAL_KEY (timingSafeEqual, fail-closed).
// Quyết định: KHÔNG dùng requireGateway ở đây vì không có Bearer token của user.
router.post('/:id/confirm', requireInternalAuth, validate(schemas.paramIdSchema), paymentController.confirm);
router.post('/:id/refund',  requireInternalAuth, validate(schemas.paramIdSchema), paymentController.refund);

export default router;
