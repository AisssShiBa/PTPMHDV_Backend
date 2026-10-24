import express from 'express'
import {
  setupPin,
  verifyPin,
  changePin,
  getPinStatus
} from '../controllers/pinController'
import { protectedRoute } from '../middlewares/authenticate'
import { validateRequest } from '../middlewares/validateRequest'
import { rateLimiter } from '../middlewares/rateLimiter'
import {
  setupPinSchema,
  verifyPinSchema,
  changePinSchema
} from '../validations/pinValidation'

const router = express.Router()

/**
 * TẤT CẢ các endpoint liên quan đến mã PIN đều yêu cầu người dùng phải đăng nhập
 * (phải mang Access Token Bearer hợp lệ)
 */
router.use(protectedRoute)

/**
 * 1. Cài đặt mã PIN lần đầu
 * POST /setup (hoặc /api/auth-txn/pin/setup)
 * Giới hạn: Tối đa 10 lần gọi trong 15 phút
 */
router.post(
  '/setup',
  rateLimiter(15 * 60 * 1000, 10),
  validateRequest(setupPinSchema),
  setupPin
)

/**
 * 2. Xác thực mã PIN và nhận transactionToken (Nhiệm vụ Đ7 & Đ8)
 * POST /verify (hoặc /api/auth-txn/pin/verify)
 * Giới hạn: Tối đa 20 lần gọi trong 15 phút
 */
router.post(
  '/verify',
  rateLimiter(15 * 60 * 1000, 20),
  validateRequest(verifyPinSchema),
  verifyPin
)

/**
 * 3. Đổi mã PIN giao dịch
 * POST /change (hoặc /api/auth-txn/pin/change)
 * Giới hạn: Tối đa 10 lần gọi trong 15 phút
 */
router.post(
  '/change',
  rateLimiter(15 * 60 * 1000, 10),
  validateRequest(changePinSchema),
  changePin
)

/**
 * 4. Kiểm tra trạng thái mã PIN của tài khoản
 * GET /status (hoặc /api/auth-txn/pin/status)
 */
router.get('/status', getPinStatus)

export default router
