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

/* 
Router được máy chỉ VNPAY tự động gọi sang hệ thống thông báo:
    - Thông báo kết quả.
    - Kích hoạt cộng tiền vào ví.
*/
router.get('/vnpay/ipn',    topupController.vnpayIpn);
// Router dùng cho NGười dùng xem
router.get('/vnpay/return', topupController.vnpayReturn);



// --- Routes YÊU CẦU XÁC THỰC (User endpoints) ---
// Tất cả các route dưới đây yêu cầu Gateway Token hợp lệ (ES256, TTL 60s).
// Tạo đơn nạp tiền & lấy link thanh toán VNPAY.
router.post('/', requireGateway, attachRequestId, validate(schemas.createTopupSchema), topupController.createTopup);
// Lấy danh sách toàn bộ lịch sử các lần nạp tiền của chính người dùng đang đăng nhập.
router.get('/',  requireGateway, attachRequestId, topupController.getMyTopups);
//Lấy thông tin chi tiết của một đơn nạp tiền theo id.
router.get('/:id', requireGateway, attachRequestId, validate(schemas.paramIdSchema), topupController.getTopup);

export default router;
