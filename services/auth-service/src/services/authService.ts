import bcrypt from 'bcrypt'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { prisma } from '../config/prisma'
import { env } from '../config/env'
import { internalApi } from '../lib/internalApi'
import { AppError } from '../utils/errors'
import { SignUpInput, SignInInput } from '../validations/authValidation'

const ACCESS_TOKEN_EXPIRATION = '15m'
const REFRESH_TOKEN_EXPIRATION_MS = 14 * 24 * 60 * 60 * 1000 // 14 ngày

// Chuỗi bcrypt hash giả lập để bảo vệ Constant-Time chống Timing Attack khi user không tồn tại
const DUMMY_BCRYPT_HASH = '$2b$10$e8wz7902EwB6u5kCj81HDeP78F1G7N8tqgVn5vV.5N4Cq3wE2bH2S'

/**
 * Hàm băm SHA-256 dùng để lưu trữ Refresh Token an toàn trong Database
 */
const hashToken = (token: string): string => {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export const AuthService = {
  /**
   * 1. Đăng ký tài khoản người dùng mới
   */
  signUp: async (input: SignUpInput, requestId?: string) => {
    const { email, password, username, firstName, lastName } = input

    // Kiểm tra trùng lặp email hoặc username
    const existing = await prisma.user.findFirst({
      where: {
        OR: [{ email }, { username }]
      }
    })

    if (existing) {
      const field = existing.email === email ? 'Email' : 'Tên đăng nhập'
      throw new AppError(409, 'DUPLICATE_RESOURCE', `${field} đã được sử dụng`)
    }

    // Mã hóa mật khẩu
    const hashedPassword = await bcrypt.hash(password, 10)

    // Tạo Auth User trong cơ sở dữ liệu của auth-service
    const newUser = await prisma.user.create({
      data: {
        username,
        firstName,
        lastName,
        email,
        password: hashedPassword
      }
    })

    // Đồng bộ sang user-service và wallet-service
    const syncResults = await Promise.allSettled([
      internalApi.post(
        `${env.userServiceUrl}/api/users`,
        { authUserId: newUser.id, email, fullName: `${firstName} ${lastName}` },
        { headers: { 'X-Request-Id': requestId }, timeout: 2000 }
      ),
      internalApi.post(
        `${env.walletServiceUrl}/api/wallets`,
        { userId: newUser.id },
        { headers: { 'X-Request-Id': requestId }, timeout: 2000 }
      )
    ])

    syncResults.forEach((r, idx) => {
      if (r.status === 'rejected') {
        const target = idx === 0 ? 'user-service' : 'wallet-service'
        console.error(`[SYNC WARNING] Không thể đồng bộ tài khoản tới ${target}:`, r.reason?.message, '| RequestId:', requestId)
      }
    })

    return {
      userId: newUser.id,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        firstName: newUser.firstName,
        lastName: newUser.lastName,
        role: newUser.role
      }
    }
  },

  /**
   * 2. Đăng nhập hệ thống (Bảo vệ Constant-time & Hash Refresh Token)
   */
  signIn: async (input: SignInInput) => {
    const { username, password } = input

    // Tìm kiếm user theo username
    const user = await prisma.user.findUnique({
      where: { username }
    })

    // Constant-Time Comparison: Luôn chạy bcrypt.compare kể cả khi user không tồn tại
    const hashToCompare = user ? user.password : DUMMY_BCRYPT_HASH
    const isPasswordValid = await bcrypt.compare(password, hashToCompare)

    if (!user || !isPasswordValid) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Tên đăng nhập hoặc mật khẩu không chính xác')
    }

    // Ký Access Token ngắn hạn (15 phút)
    const accessToken = jwt.sign(
      { userId: user.id, role: user.role },
      env.accessTokenSecret,
      { expiresIn: ACCESS_TOKEN_EXPIRATION }
    )

    // Sinh Refresh Token ngẫu nhiên (64 bytes)
    const rawRefreshToken = crypto.randomBytes(64).toString('hex')
    const tokenHash = hashToken(rawRefreshToken)

    // Lưu vào Session dưới dạng Hash SHA-256 (Không lưu plaintext)
    await prisma.session.create({
      data: {
        refreshToken: tokenHash,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRATION_MS),
        userId: user.id
      }
    })

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role
      }
    }
  },

  /**
   * 3. Làm mới token với cơ chế xoay vòng (Refresh Token Rotation - RTR)
   */
  refresh: async (rawRefreshToken: string | undefined) => {
    if (!rawRefreshToken) {
      throw new AppError(401, 'REFRESH_TOKEN_NOT_FOUND', 'Không tìm thấy refresh token trong cookie')
    }

    const tokenHash = hashToken(rawRefreshToken)

    // Tìm session theo chuỗi hash
    const session = await prisma.session.findUnique({
      where: { refreshToken: tokenHash },
      include: { user: true }
    })

    // Kiểm tra tính hợp lệ và thời hạn session
    if (!session || session.expiresAt < new Date()) {
      if (session) {
        // Dọn dẹp session đã hết hạn
        await prisma.session.delete({ where: { id: session.id } }).catch(() => {})
      }
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Phiên đăng nhập đã hết hạn hoặc không hợp lệ')
    }

    // Sinh Refresh Token mới (Rotation)
    const newRawRefreshToken = crypto.randomBytes(64).toString('hex')
    const newTokenHash = hashToken(newRawRefreshToken)

    // Thực hiện xoay vòng token nguyên tử trong Transaction: Xóa token cũ, tạo token mới
    await prisma.$transaction(async (tx) => {
      await tx.session.delete({ where: { id: session.id } })
      await tx.session.create({
        data: {
          refreshToken: newTokenHash,
          expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRATION_MS),
          userId: session.userId
        }
      })
    })

    // Ký Access Token mới
    const accessToken = jwt.sign(
      { userId: session.user.id, role: session.user.role },
      env.accessTokenSecret,
      { expiresIn: ACCESS_TOKEN_EXPIRATION }
    )

    return {
      accessToken,
      refreshToken: newRawRefreshToken,
      user: {
        id: session.user.id,
        username: session.user.username,
        email: session.user.email,
        firstName: session.user.firstName,
        lastName: session.user.lastName,
        role: session.user.role
      }
    }
  },

  /**
   * 4. Đăng xuất và thu hồi session
   */
  signOut: async (rawRefreshToken: string | undefined) => {
    if (rawRefreshToken) {
      const tokenHash = hashToken(rawRefreshToken)
      await prisma.session.deleteMany({
        where: { refreshToken: tokenHash }
      }).catch(() => {})
    }
    return true
  }
}
