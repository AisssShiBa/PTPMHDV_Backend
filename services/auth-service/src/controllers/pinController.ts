import { Request, Response } from 'express'
import { PinService } from '../services/pinService'
import { success } from '../utils/response'
import { asyncHandler, AppError } from '../utils/errors'

/**
 * Trích xuất userId một cách an toàn:
 * Ưu tiên:
 * 1. req.user.id (từ middleware authenticate / protectedRoute)
 * 2. Header 'x-user-id' (khi request được Gateway chuyển tiếp nội bộ)
 */
const getAuthenticatedUserId = (req: Request): string => {
  const userId = (req as any).user?.id || (req.headers['x-user-id'] as string)
  if (!userId) {
    throw new AppError(401, 'UNAUTHORIZED', 'Chưa đăng nhập hoặc không thể xác thực danh tính người dùng')
  }
  return userId
}

/**
 * 1. Cài đặt mã PIN lần đầu (Setup PIN)
 * POST /api/auth-txn/pin/setup
 */
export const setupPin = asyncHandler(async (req: Request, res: Response): Promise<Response> => {
  const userId = getAuthenticatedUserId(req)
  const result = await PinService.setupPin(userId, req.body)
  return success(res, 201, result, result.message)
})

/**
 * 2. Xác thực mã PIN giao dịch và nhận transactionToken (Verify PIN)
 * POST /api/auth-txn/pin/verify
 * 
 * Response khi thành công:
 * {
 *   success: true,
 *   data: {
 *     transactionToken: "eyJh...",
 *     expiresIn: 60
 *   },
 *   message: "Xác thực mã PIN thành công"
 * }
 */
export const verifyPin = asyncHandler(async (req: Request, res: Response): Promise<Response> => {
  const userId = getAuthenticatedUserId(req)
  const result = await PinService.verifyPin(userId, req.body)
  return success(res, 200, result, result.message)
})

/**
 * 3. Thay đổi mã PIN giao dịch (Change PIN)
 * POST /api/auth-txn/pin/change
 */
export const changePin = asyncHandler(async (req: Request, res: Response): Promise<Response> => {
  const userId = getAuthenticatedUserId(req)
  const result = await PinService.changePin(userId, req.body)
  return success(res, 200, result, result.message)
})

/**
 * 4. Kiểm tra trạng thái mã PIN của người dùng (Get PIN Status)
 * GET /api/auth-txn/pin/status
 */
export const getPinStatus = asyncHandler(async (req: Request, res: Response): Promise<Response> => {
  const userId = getAuthenticatedUserId(req)
  const result = await PinService.getPinStatus(userId)
  return success(res, 200, result, 'Lấy trạng thái mã PIN thành công')
})
