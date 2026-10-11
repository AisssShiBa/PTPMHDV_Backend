import { Router, Response, NextFunction } from 'express';
import { requireGateway, requireRole } from 'finvault-internal-auth';   // ← từ package chung
import { attachRequestId } from '../middlewares/requestId';
import { validate } from '../middlewares/validate';
import * as topupController from '../controllers/topup.controller';
import * as schemas from '../validations/topup.validation';

const router = Router();

// Tất cả route admin:
//   1. Đi qua API Gateway (xác thực ES256 x-gateway-token)
//   2. Có role ADMIN trong token (không thể giả mạo)
router.use(requireGateway);
router.use(requireRole('ADMIN'));
router.use(attachRequestId);

router.get('/', topupController.getAdminTopups);
router.post('/:id/approve', validate(schemas.paramIdSchema), topupController.approveTopup);
router.post('/:id/reject',  validate(schemas.rejectTopupSchema), topupController.rejectTopup);

export default router;
