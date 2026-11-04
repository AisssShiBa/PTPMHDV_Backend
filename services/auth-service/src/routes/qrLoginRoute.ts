import express, { Request, Response, NextFunction } from 'express'
import {
  initQr,
  getQrStatus,
  confirmQr
} from '../controllers/qrLoginController'
import { rateLimiter } from '../middlewares/rateLimiter'
import { authenticateServiceRequest } from '../middlewares/authenticateServiceRequest'
import { protectedRoute } from '../middlewares/authenticate'

const router = express.Router()

/**
 * Middleware xác thực đa kênh linh hoạt cho Mobile confirm:
 * - Khi đi qua API Gateway: Kiểm tra x-gateway-token (ES256)
 * - Khi gọi trực tiếp Auth-Service: Kiểm tra Bearer Access Token
 */
const requireMobileAuth = (req: Request, res: Response, next: NextFunction) => {
  if (req.headers['x-gateway-token'] || req.headers['x-internal-key']) {
    return authenticateServiceRequest(req, res, next)
  }
  return protectedRoute(req, res, next)
}

/**
 * 1. Khởi tạo phiên mã QR mới (Web gọi công khai)
 * POST /init (Route đầy đủ: /api/auth/qr-login/init)
 * Giới hạn: Tối đa 30 lần gọi trong 1 phút
 */
router.post('/init', rateLimiter(60 * 1000, 30), initQr)

/**
 * 2. Web polling kiểm tra trạng thái mã QR (Web gọi công khai kèm pollSecret)
 * GET /:id/status (Route đầy đủ: /api/auth/qr-login/:id/status)
 * Giới hạn: Tối đa 60 lần gọi trong 1 phút (tương ứng chu kỳ polling 2s/lần)
 */
router.get('/:id/status', rateLimiter(60 * 1000, 60), getQrStatus)

/**
 * 3. Mobile xác nhận đăng nhập sau khi quét mã (Bắt buộc xác thực danh tính)
 * POST /confirm (Route đầy đủ: /api/auth/qr-login/confirm)
 * Giới hạn: Tối đa 20 lần gọi trong 1 phút
 */
router.post('/confirm', requireMobileAuth, rateLimiter(60 * 1000, 20), confirmQr)

export default router

