import { Request, Response } from 'express'
import { prisma } from '../config/prisma'
import bcrypt from 'bcrypt'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { fail, success } from '../utils/response'
import { internalApi } from '../lib/internalApi'
import { signUpSchema } from '../validations/authValidation'
const ACCESS_TOKEN_EXPIRATION = '15m'
const REFRESH_TOKEN_EXPIRATION = 14 * 24 * 60 * 60 * 1000 // 14 ngày
export const signUp = async (req: Request, res: Response) => {
  try {
    const parsed = signUpSchema.safeParse(req.body)
    if (!parsed.success) {
      const firstError = parsed.error.issues[0]
      return fail(res, 400, 'VALIDATION_ERROR', firstError.message)
    }

    const { email, password, username, firstName, lastName } = parsed.data

    // Kiểm tra trùng lặp Email hoặc Username
    const duplicateUser = await prisma.user.findFirst({
      where: { OR: [{ email }, { username }] }
    })

    if (duplicateUser) {
      const field = duplicateUser.email === email ? 'Email' : 'Tên đăng nhập'
      return fail(res, 409, 'DUPLICATE_RESOURCE', `${field} đã được sử dụng`)
    }

    // Mã hóa mật khẩu
    const hashedPassword = await bcrypt.hash(password, 10)

    // Tạo Auth User trong DB của auth-service
    const newUser = await prisma.user.create({
      data: { username, firstName, lastName, email, password: hashedPassword }
    })

    // Lấy Correlation ID từ Middleware
    const requestId = (req as any).requestId

    // Gọi song song sang user-service (Port 3002) và wallet-service (Port 3004)
    const results = await Promise.allSettled([
      internalApi.post(
        `${process.env.USER_SERVICE_URL || 'http://localhost:3002'}/api/users`,
        { authUserId: newUser.id, email, fullName: `${firstName} ${lastName}` },
        { headers: { 'X-Request-Id': requestId }, timeout: 2000 }
      ),
      internalApi.post(
        `${process.env.WALLET_SERVICE_URL || 'http://localhost:3004'}/api/wallets`,
        { userId: newUser.id },
        { headers: { 'X-Request-Id': requestId }, timeout: 2000 }
      )
    ])

    // Kiểm tra log lỗi nếu có service chưa bật hoặc bị timeout
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const serviceName = i === 0 ? 'user-service' : 'wallet-service'
        console.error(
          `[SYNC ERROR] Không thể tạo dữ liệu tại ${serviceName}:`,
          r.reason?.message,
          '| RequestId:',
          requestId
        )
      }
    })

    return success(
      res,
      201,
      {
        userId: newUser.id,
        user: {
          id: newUser.id,
          username: newUser.username,
          email: newUser.email,
          firstName: newUser.firstName,
          lastName: newUser.lastName,
          role: newUser.role
        }
      },
      'Đăng ký thành công'
    )
  } catch (error: any) {
    if (error.code === 'P2002') {
      return fail(
        res,
        409,
        'DUPLICATE_RESOURCE',
        'Email hoặc tên đăng nhập đã được sử dụng'
      )
    }
    console.error('Lỗi đăng ký người dùng:', error)
    return fail(res, 500, 'INTERNAL_ERROR', 'Lỗi hệ thống')
  }
}
export const signIn = async (req: Request, res: Response) => {
  try {
    // Lấy thông tin đăng nhập từ request
    const { username, password } = req.body
    if (!username || !password) {
      return fail(
        res,
        400,
        'VALIDATION_ERROR',
        'Username và mật khẩu là bắt buộc'
      )
    }
    //lấy hasspassword so với password
    const user = await prisma.user.findUnique({ where: { username } })

    if (!user) {
      return fail(res, 401, 'USER_NOT_FOUND', 'Username không tìm thấy')
    }
    const passwordCorrect = await bcrypt.compare(password, user.password)
    if (!passwordCorrect) {
      return fail(res, 401, 'INVALID_CREDENTIALS', 'Mật khẩu không đúng')
    }
    //nếu khớp tạo access token với jwt
    const accessToken = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.ACCESS_TOKEN_SECRET as string,
      { expiresIn: ACCESS_TOKEN_EXPIRATION }
    )
    //tạo refreshtoken
    const refreshToken = crypto.randomBytes(64).toString('hex')
    //tạo session mới để lưu refresh token
    await prisma.session.create({
      data: {
        refreshToken,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRATION),
        userId: user.id
      }
    })
    //trả về access token và refresh token về trong cookie
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      //secure == false tránh lỗi khi chạy trên localhost, secure == true khi chạy trên production
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: REFRESH_TOKEN_EXPIRATION
    })
    return success(
      res,
      200,
      {
        accessToken,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role
        }
      },
      'Đăng nhập thành công'
    )
    //trả access về trong res
  } catch (error) {
    console.error('Lỗi đăng nhập người dùng:', error)
    return fail(res, 500, 'INTERNAL_SERVER_ERROR', 'Lỗi hệ thống')
  }
}
export const refresh = async (req: Request, res: Response) => {
  try {
    //lay refresh token từ cookie
    const refreshToken = req.cookies.refreshToken
    if (!refreshToken) {
      return fail(
        res,
        401,
        'REFRESH_TOKEN_NOT_FOUND',
        'không tìm thấy refresh token'
      )
    }
    //tim session trong db với refresh token
    const session = await prisma.session.findUnique({
      where: { refreshToken },
      include: { user: true }
    })

    //kiem tra session có tồn tại và chưa hết hạn
    if (!session || session.expiresAt < new Date()) {
      return fail(
        res,
        401,
        'INVALID_REFRESH_TOKEN',
        'Refresh token không hợp lệ hoặc đã hết hạn'
      )
    }
    //tạo access token
    const accessToken = jwt.sign(
      { userId: session.userId, role: session.user.role },
      process.env.ACCESS_TOKEN_SECRET as string,
      { expiresIn: ACCESS_TOKEN_EXPIRATION }
    )
    //trả access về trong res
    return success(
      res,
      200,
      {
        accessToken,
        user: {
          id: session.user.id,
          username: session.user.username,
          email: session.user.email,
          firstName: session.user.firstName,
          lastName: session.user.lastName,
          role: session.user.role
        }
      },
      'Làm mới token thành công'
    )
  } catch (error) {
    console.error('Lỗi làm mới access token:', error)
    return fail(res, 500, 'INTERNAL_SERVER_ERROR', 'Lỗi hệ thống')
  }
}
export const signOut = async (req: Request, res: Response) => {
  try {
    //lay refresh token từ cookie
    const token = req.cookies.refreshToken
    if (token) {
      //xoa refresh trong session
      await prisma.session.deleteMany({ where: { refreshToken: token } })
      //xoa cookie
      res.clearCookie('refreshToken', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production'
      })
    }
    return res.sendStatus(204)
  } catch (error) {
    console.error('Lỗi đăng xuất người dùng:', error)
    return fail(res, 500, 'INTERNAL_SERVER_ERROR', 'Lỗi hệ thống')
  }
}
