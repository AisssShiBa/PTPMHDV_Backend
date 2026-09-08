import { Router } from 'express';
import { paymentController } from '../controllers/payment.controller';

const router = Router();

// Endpoint checkout
router.post('/checkout', paymentController.checkout);

// Endpoint confirm
router.post('/:id/confirm', paymentController.confirm);

// Endpoint get by id
router.get('/:id', paymentController.getPayment);

// Endpoint get list
router.get('/', paymentController.getPayments);

// Endpoint refund
router.post('/:id/refund', paymentController.refund);

export default router;
