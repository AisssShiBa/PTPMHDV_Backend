import { Request, Response } from 'express'
import { QrLoginService } from '../services/qrLoginService'
import { success } from '../utils/response'
import { asyncHandler, AppError } from '../utils/errors'
import { env } from '../config/env'

const REFRESH_TOKEN_MAX_AGE = 14 * 24 * 60 * 60 * 1000 // 14 ngày

/**
 * Cấu hình Cookie an toàn cho Refresh Token trên Web Client (chống XSS)
 */
const getCookieOptions = () => ({
  httpOnly: true,
  secure: env.isProduction,
  sameSite: (env.isProduction ? 'none' : 'lax') as 'none' | 'lax',
  path: '/api/auth',
  maxAge: REFRESH_TOKEN_MAX_AGE
})

/**
 * Trích xuất định danh userId của người dùng Mobile đã đăng nhập
 */
const getUserIdFromRequest = (req: Request): string => {
  const userId =
    (req as any).user?.id ||
    (req as any).auth?.userId ||
    (typeof req.headers['x-user-id'] === 'string' ? req.headers['x-user-id'] : undefined)

  if (!userId) {
    throw new AppError(401, 'UNAUTHORIZED', 'Bạn cần đăng nhập để thực hiện xác nhận mã QR')
  }

  return userId
}

/**
 * 1. Khởi tạo mã QR (Web gọi công khai)
 * POST /api/auth/qr-login/init
 */
export const initQr = asyncHandler(async (_req: Request, res: Response): Promise<Response> => {
  const result = await QrLoginService.initQr()
  return success(res, 201, result, 'Khởi tạo phiên QR Login thành công')
})

/**
 * 2. Web polling kiểm tra trạng thái mã QR (Web gọi định kỳ mỗi 2s)
 * GET /api/auth/qr-login/:id/status
 */
export const getQrStatus = asyncHandler(async (req: Request, res: Response): Promise<Response> => {
  const qrId = req.params.id

  // Đọc pollSecret từ Header x-poll-secret hoặc Query parameter ?pollSecret=...
  const pollSecret = (
    req.headers['x-poll-secret'] ||
    req.query.pollSecret
  ) as string | undefined

  if (!pollSecret || typeof pollSecret !== 'string') {
    throw new AppError(400, 'BAD_REQUEST', 'Thiếu pollSecret để kiểm tra trạng thái mã QR')
  }

  const result = await QrLoginService.getQrStatus(qrId, pollSecret)

  // Nếu người dùng đã xác nhận trên điện thoại thành công:
  if (result.status === 'APPROVED' && result.refreshToken) {
    // Gắn Refresh Token vào HTTP-Only Cookie cho Web
    res.cookie('refreshToken', result.refreshToken, getCookieOptions())

    return success(
      res,
      200,
      {
        status: 'APPROVED',
        accessToken: result.accessToken,
        user: result.user
      },
      'Đăng nhập qua mã QR thành công'
    )
  }

  // Trường hợp đang chờ quét (PENDING) hoặc từ chối (REJECTED)
  return success(res, 200, result, 'Kiểm tra trạng thái mã QR thành công')
})

/**
 * 3. Mobile xác nhận đăng nhập sau khi quét mã QR (Yêu cầu đăng nhập)
 * POST /api/auth/qr-login/confirm
 */
export const confirmQr = asyncHandler(async (req: Request, res: Response): Promise<Response> => {
  const userId = getUserIdFromRequest(req)
  const { qrId, nonce } = req.body

  if (!qrId || !nonce) {
    throw new AppError(400, 'BAD_REQUEST', 'Dữ liệu không hợp lệ: Cần có qrId và nonce')
  }

  const result = await QrLoginService.confirmQr(userId, { qrId, nonce })
  return success(res, 200, result, result.message)
})

