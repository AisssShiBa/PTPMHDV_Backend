import { Router } from 'express';
import { validate } from '../middlewares/validate';
import { attachRequestId } from '../middlewares/requestId';
import { requireGateway } from '../middlewares/requireGateway';
import { requireInternalAuth } from '../middlewares/internalAuth';
import * as paymentController from '../controllers/payment.controller';
import * as schemas from '../validations/payment.validation';

const router = Router();

router.post('/checkout', requireGateway, attachRequestId, validate(schemas.checkoutSchema), paymentController.checkout);
router.post('/:id/confirm', requireInternalAuth, validate(schemas.paramIdSchema), paymentController.confirm);
router.post('/:id/refund', requireInternalAuth, validate(schemas.paramIdSchema), paymentController.refund);
router.post('/:id/cancel', requireGateway, attachRequestId, validate(schemas.paramIdSchema), paymentController.cancel);
router.get('/:id', requireGateway, attachRequestId, validate(schemas.paramIdSchema), paymentController.getById);
router.get('/', requireGateway, attachRequestId, validate(schemas.paginationSchema), paymentController.list);

export default router;
