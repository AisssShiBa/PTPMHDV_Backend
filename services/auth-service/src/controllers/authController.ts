import { Request, Response } from 'express'
import { AuthService } from '../services/authService'
import { success } from '../utils/response'
import { asyncHandler } from '../utils/errors'
import { env } from '../config/env'

const REFRESH_TOKEN_MAX_AGE = 14 * 24 * 60 * 60 * 1000 // 14 ngày

/**
 * Cấu hình Cookie đồng nhất cho Refresh Token
 */
const getCookieOptions = () => ({
  httpOnly: true,
  secure: env.isProduction,
  sameSite: (env.isProduction ? 'none' : 'lax') as 'none' | 'lax',
  path: '/api/auth',
  maxAge: REFRESH_TOKEN_MAX_AGE
})

/**
 * 1. Đăng ký tài khoản
 */
export const signUp = asyncHandler(async (req: Request, res: Response) => {
  const requestId = (req as any).requestId
  const result = await AuthService.signUp(req.body, requestId)
  return success(res, 201, result, 'Đăng ký thành công')
})

/**
 * 2. Đăng nhập tài khoản
 */
export const signIn = asyncHandler(async (req: Request, res: Response) => {
  const result = await AuthService.signIn(req.body)

  // Lưu Refresh Token vào HTTP-Only Cookie an toàn
  res.cookie('refreshToken', result.refreshToken, getCookieOptions())

  return success(
    res,
    200,
    {
      accessToken: result.accessToken,
      user: result.user
    },
    'Đăng nhập thành công'
  )
})

/**
 * 3. Làm mới Access Token (Kèm xoay vòng Refresh Token)
 */
export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const rawRefreshToken = req.cookies?.refreshToken
  const result = await AuthService.refresh(rawRefreshToken)

  // Cập nhật lại Cookie với Refresh Token mới được xoay vòng
  res.cookie('refreshToken', result.refreshToken, getCookieOptions())

  return success(
    res,
    200,
    {
      accessToken: result.accessToken,
      user: result.user
    },
    'Làm mới token thành công'
  )
})

/**
 * 4. Đăng xuất tài khoản
 */
export const signOut = asyncHandler(async (req: Request, res: Response) => {
  const rawRefreshToken = req.cookies?.refreshToken
  await AuthService.signOut(rawRefreshToken)

  // Xóa cookie với chính xác các tùy chọn như lúc tạo
  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: (env.isProduction ? 'none' : 'lax') as 'none' | 'lax',
    path: '/api/auth'
  })

  return success(res, 200, null, 'Đăng xuất thành công')
})
