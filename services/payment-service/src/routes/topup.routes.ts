import { Router } from 'express';
import { requireGateway } from 'finvault-internal-auth';      // ← từ package chung
import { attachRequestId } from '../middlewares/requestId';
import { validate } from '../middlewares/validate';
import * as topupController from '../controllers/topup.controller';
import * as schemas from '../validations/topup.validation';

const router = Router();

// --- Routes CÔNG KHAI (Public): VNPay callback/IPN ---
// Đây là webhook/redirect từ VNPay bên ngoài, không có user Bearer token.
// Được whitelist tại gateway/authenticate.ts (PUBLIC_ROUTES) và bảo vệ
// bằng VNPay HMAC checksum trong topupService.handleVnpayIpn / handleVnpayReturn.
// KHÔNG gắn requireGateway ở đây để tránh reject request hợp lệ từ VNPay.
router.get('/vnpay/ipn',    topupController.vnpayIpn);
router.get('/vnpay/return', topupController.vnpayReturn);

// --- Routes YÊU CẦU XÁC THỰC (User endpoints) ---
// Tất cả các route dưới đây yêu cầu Gateway Token hợp lệ (ES256, TTL 60s).
router.post('/', requireGateway, attachRequestId, validate(schemas.createTopupSchema), topupController.createTopup);
router.get('/',  requireGateway, attachRequestId, topupController.getMyTopups);
router.get('/:id', requireGateway, attachRequestId, validate(schemas.paramIdSchema), topupController.getTopup);

export default router;
