import { Request, Response } from 'express'
import { AuthService } from '../services/authService'
import { success } from '../utils/response'
import { asyncHandler } from '../utils/errors'
import { env } from '../config/env'

const REFRESH_TOKEN_MAX_AGE = 14 * 24 * 60 * 60 * 1000 // 14 ngày

/**
 * Cấu hình Cookie đồng nhất cho Refresh Token trên Web Client
 */
const getCookieOptions = () => ({
  httpOnly: true,
  secure: env.isProduction,
  sameSite: (env.isProduction ? 'none' : 'lax') as 'none' | 'lax',
  path: '/api/auth',
  maxAge: REFRESH_TOKEN_MAX_AGE
})

/**
 * Nhận diện nền tảng Client gửi request (Web vs Mobile App)
 * Ưu tiên: Header 'x-client-platform' -> Request Body 'platform'
 */
const isMobileClient = (req: Request): boolean => {
  const headerPlatform = req.headers['x-client-platform']
  if (typeof headerPlatform === 'string' && headerPlatform.toLowerCase() === 'mobile') {
    return true
  }
  if (typeof req.body?.platform === 'string' && req.body.platform.toLowerCase() === 'mobile') {
    return true
  }
  return false
}

/**
 * Trích xuất Refresh Token linh hoạt hỗ trợ đa nền tảng:
 * - Web: Đọc từ HTTP-Only Cookie
 * - Mobile: Đọc từ JSON Request Body hoặc Custom Header
 */
const extractRefreshToken = (req: Request): string | undefined => {
  const fromCookie = req.cookies?.refreshToken
  if (typeof fromCookie === 'string' && fromCookie.trim().length > 0) {
    return fromCookie.trim()
  }

  const fromBody = req.body?.refreshToken
  if (typeof fromBody === 'string' && fromBody.trim().length > 0) {
    return fromBody.trim()
  }

  const fromHeader = req.headers['x-refresh-token']
  if (typeof fromHeader === 'string' && fromHeader.trim().length > 0) {
    return fromHeader.trim()
  }

  return undefined
}

/**
 * 1. Đăng ký tài khoản người dùng mới
 */
export const signUp = asyncHandler(async (req: Request, res: Response): Promise<Response> => {
  const requestId = (req as any).requestId
  const result = await AuthService.signUp(req.body, requestId)
  return success(res, 201, result, 'Đăng ký thành công')
})

/**
 * 2. Đăng nhập tài khoản (Hỗ trợ phân luồng Web vs Mobile)
 * - Web: Lưu Refresh Token vào HTTP-Only Cookie an toàn chống XSS
 * - Mobile: Trả Refresh Token trực tiếp trong JSON Response Body để lưu vào SecureStore / KeyChain
 */
export const signIn = asyncHandler(async (req: Request, res: Response): Promise<Response> => {
  const result = await AuthService.signIn(req.body)
  const isMobile = isMobileClient(req)

  if (!isMobile) {
    // Web: Set HTTP-Only Cookie
    res.cookie('refreshToken', result.refreshToken, getCookieOptions())
  }

  return success(
    res,
    200,
    {
      accessToken: result.accessToken,
      // Mobile: Bổ sung refreshToken vào body
      ...(isMobile ? { refreshToken: result.refreshToken } : {}),
      user: result.user
    },
    'Đăng nhập thành công'
  )
})

/**
 * 3. Làm mới Access Token (Kèm xoay vòng Refresh Token - RTR)
 * - Hỗ trợ nhận refreshToken từ Cookie (Web) hoặc Body/Header (Mobile)
 * - Nếu là Mobile: Trả refreshToken mới được xoay vòng trong JSON Body
 */
export const refresh = asyncHandler(async (req: Request, res: Response): Promise<Response> => {
  const rawRefreshToken = extractRefreshToken(req)
  const result = await AuthService.refresh(rawRefreshToken)
  const isMobile = isMobileClient(req)

  if (!isMobile) {
    // Web: Cập nhật lại Cookie với Refresh Token mới được xoay vòng
    res.cookie('refreshToken', result.refreshToken, getCookieOptions())
  }

  return success(
    res,
    200,
    {
      accessToken: result.accessToken,
      // Mobile: Cung cấp refreshToken xoay vòng mới qua Body
      ...(isMobile ? { refreshToken: result.refreshToken } : {}),
      user: result.user
    },
    'Làm mới token thành công'
  )
})

/**
 * 4. Đăng xuất tài khoản và thu hồi session
 */
export const signOut = asyncHandler(async (req: Request, res: Response): Promise<Response> => {
  const rawRefreshToken = extractRefreshToken(req)
  await AuthService.signOut(rawRefreshToken)

  const isMobile = isMobileClient(req)
  if (!isMobile) {
    // Web: Xóa cookie với chính xác các tùy chọn như lúc tạo
    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: env.isProduction,
      sameSite: (env.isProduction ? 'none' : 'lax') as 'none' | 'lax',
      path: '/api/auth'
    })
  }

  return success(res, 200, null, 'Đăng xuất thành công')
})
