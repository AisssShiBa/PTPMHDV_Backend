import bcrypt from 'bcrypt'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { prisma } from '../config/prisma'
import { env } from '../config/env'
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

    // Áp dụng Transactional Outbox Pattern:
    // Tạo User VÀ Ghi sự kiện Outbox trong cùng 1 Transaction nguyên tử duy nhất.
    // Nếu 1 trong 2 gặp sự cố, toàn bộ sẽ được Rollback tự động.
    const newUser = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          username,
          firstName,
          lastName,
          email,
          password: hashedPassword
        }
      })

      await tx.authOutboxEvent.create({
        data: {
          aggregateId: user.id,
          eventType: 'user.registered',
          payload: {
            authUserId: user.id,
            email: user.email,
            username: user.username,
            firstName: user.firstName,
            lastName: user.lastName
          },
          status: 'PENDING'
        }
      })

      return user
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
   * 2. Đăng nhập hệ thống (Bảo vệ Constant-time, Hash Token & Khởi tạo Token Family - Nhiệm vụ Đ15b)
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

    // Khởi tạo một familyId mới cho chuỗi phiên làm việc này (Nhiệm vụ Đ15b)
    const familyId = crypto.randomUUID()

    // Lưu vào Session dưới dạng Hash SHA-256 kèm familyId và revokedAt = null
    await prisma.session.create({
      data: {
        refreshToken: tokenHash,
        familyId,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRATION_MS),
        userId: user.id,
        revokedAt: null
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
   * 3. Làm mới token với cơ chế xoay vòng (RTR) & Phát hiện tái sử dụng Token (Token Reuse Detection - Đ15b)
   */
  refresh: async (rawRefreshToken: string | undefined) => {
    if (!rawRefreshToken) {
      throw new AppError(401, 'REFRESH_TOKEN_NOT_FOUND', 'Không tìm thấy refresh token trong cookie')
    }

    const tokenHash = hashToken(rawRefreshToken)

    // Tìm session theo chuỗi hash SHA-256
    const session = await prisma.session.findUnique({
      where: { refreshToken: tokenHash },
      include: { user: true }
    })

    // Trường hợp 1: Token hoàn toàn không tồn tại trong hệ thống
    if (!session) {
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Phiên đăng nhập đã hết hạn hoặc không hợp lệ')
    }

    // Trường hợp 2 (BÁO ĐỘNG ĐỎ - S1): Token ĐÃ BỊ THU HỒI / ĐÃ XOAY VÒNG mà lại được gửi lên!
    // Đây là dấu hiệu chắc chắn kẻ gian đang tái sử dụng token đã đánh cắp (Token Reuse Attack)
    if (session.revokedAt !== null) {
      // Thu hồi TOÀN BỘ các token thuộc cùng gia đình phiên này (familyId)
      await prisma.session.updateMany({
        where: { familyId: session.familyId },
        data: { revokedAt: new Date() }
      })

      throw new AppError(
        401,
        'TOKEN_REUSE_DETECTED',
        'Phát hiện refresh token đã qua sử dụng. Toàn bộ phiên liên quan đã bị thu hồi vì lý do an toàn'
      )
    }

    // Trường hợp 3: Token đã quá thời hạn hiệu lực (14 ngày)
    if (session.expiresAt < new Date()) {
      await prisma.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date() }
      }).catch(() => {})

      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Phiên đăng nhập đã hết hạn')
    }

    // Trường hợp 4: Token hợp lệ -> Tiến hành Xoay vòng (Rotation) nguyên tử
    const newRawRefreshToken = crypto.randomBytes(64).toString('hex')
    const newTokenHash = hashToken(newRawRefreshToken)

    await prisma.$transaction(async (tx) => {
      // a) Đánh dấu token cũ là ĐÃ THU HỒI (revokedAt = now), KHÔNG XÓA DÒNG để giữ làm bẫy phát hiện reuse
      await tx.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date() }
      })

      // b) Tạo session mới kế thừa CÙNG familyId để duy trì gia đình phiên
      await tx.session.create({
        data: {
          refreshToken: newTokenHash,
          familyId: session.familyId,
          expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRATION_MS),
          userId: session.userId,
          revokedAt: null
        }
      })
    })

    // Ký Access Token mới cho người dùng
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
   * 4. Đăng xuất và thu hồi toàn bộ gia đình phiên (Sign Out & Revoke Family)
   */
  signOut: async (rawRefreshToken: string | undefined) => {
    if (rawRefreshToken) {
      const tokenHash = hashToken(rawRefreshToken)
      const session = await prisma.session.findUnique({
        where: { refreshToken: tokenHash }
      })

      if (session) {
        // Thu hồi toàn bộ session cùng familyId để đăng xuất triệt để
        await prisma.session.updateMany({
          where: { familyId: session.familyId },
          data: { revokedAt: new Date() }
        }).catch(() => {})
      }
    }
    return true
  }
}
