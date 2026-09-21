import { Router } from 'express';
import { validate } from '../middlewares/validate';
import { requireAuth } from '../middlewares/requireAuth';
import * as paymentController from '../controllers/payment.controller';
import * as schemas from '../validations/payment.validation';

const router = Router();

router.post('/checkout', requireAuth, validate(schemas.checkoutSchema), paymentController.checkout);
router.post('/:id/confirm', validate(schemas.paramIdSchema), paymentController.confirm);
router.post('/:id/refund', validate(schemas.paramIdSchema), paymentController.refund);
router.post('/:id/cancel', validate(schemas.paramIdSchema), paymentController.cancel);
router.get('/:id', validate(schemas.paramIdSchema), paymentController.getById);
router.get('/', validate(schemas.paginationSchema), paymentController.list);

export default router;
