import { Router } from 'express';
import { requireGateway } from 'finvault-internal-auth';      // ← từ package chung
import { requireInternalAuth } from '../middlewares/internalAuth';
import { requireGatewayOrInternalKey } from '../middlewares/gatewayOrInternalAuth';
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
router.post('/p2p/quote',    requireGateway, attachRequestId, validate(schemas.p2pQuoteSchema), paymentController.p2pQuote);
router.post('/p2p/checkout', requireGateway, attachRequestId, validate(schemas.p2pCheckoutSchema), paymentController.p2pCheckout);
router.post('/checkout',     requireGateway, attachRequestId, validate(schemas.checkoutSchema), paymentController.checkout);
router.post('/:id/cancel',   requireGateway, attachRequestId, validate(schemas.paramIdSchema), paymentController.cancel);
router.get('/:id',           requireGateway, attachRequestId, validate(schemas.paramIdSchema), paymentController.getById);
router.get('/',              requireGateway, attachRequestId, validate(schemas.paginationSchema), paymentController.list);

// confirm hỗ trợ CẢ HAI: User xác nhận qua Gateway (Bearer token) HOẶC Service nội bộ (x-internal-key)
router.post('/:id/confirm',  requireGatewayOrInternalKey, attachRequestId, validate(schemas.paramIdSchema), paymentController.confirm);

// refund chỉ dành cho service nội bộ
router.post('/:id/refund',   requireInternalAuth, validate(schemas.paramIdSchema), paymentController.refund);

export default router;
