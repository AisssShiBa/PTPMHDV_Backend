import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { redisClient } from '../config/redis'
import { prisma } from '../config/prisma'
import { env } from '../config/env'
import { AppError } from '../utils/errors'

// Cấu hình thời gian sống của các token và phiên QR
const QR_TTL_SECONDS = 120 // Mã QR chỉ tồn tại trong 2 phút (120 giây)
const QR_APPROVED_TTL_SECONDS = 30 // Sau khi duyệt, giữ 30s để Web kịp poll lấy phiên
const ACCESS_TOKEN_EXPIRATION = '15m'
const REFRESH_TOKEN_EXPIRATION_MS = 14 * 24 * 60 * 60 * 1000 // 14 ngày

const hashToken = (token: string): string => {
  return crypto.createHash('sha256').update(token).digest('hex')
}

// Cấu trúc dữ liệu lưu trong Redis key qr:<qrId>
interface QrSessionData {
  nonce: string
  pollSecret: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  userId?: string
  createdAt: string
}

export const QrLoginService = {
  /**
   * 1. Khởi tạo phiên QR Login mới (POST /api/auth/qr-login/init)
   * Web gọi API này để lấy mã QR hiển thị lên màn hình.
   */
  initQr: async () => {
    const qrId = crypto.randomUUID()
    const nonce = crypto.randomBytes(32).toString('hex')
    const pollSecret = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + QR_TTL_SECONDS * 1000)

    const sessionData: QrSessionData = {
      nonce,
      pollSecret,
      status: 'PENDING',
      createdAt: new Date().toISOString()
    }

    // Lưu vào Redis với thời hạn sống TTL đúng 120 giây (EX 120)
    await redisClient.set(
      `qr:${qrId}`,
      JSON.stringify(sessionData),
      'EX',
      QR_TTL_SECONDS
    )

    return {
      qrId,
      nonce,
      pollSecret,
      expiresAt: expiresAt.toISOString()
    }
  },

  /**
   * 2. Web thăm dò (polling) kiểm tra trạng thái mã QR (GET /api/auth/qr-login/:id/status)
   * Web gọi định kỳ 2s/lần kèm theo pollSecret để lấy Access Token khi Mobile đã xác nhận.
   */
  getQrStatus: async (qrId: string, pollSecret: string) => {
    const key = `qr:${qrId}`
    const rawData = await redisClient.get(key)

    // Nếu không tìm thấy trong Redis -> Mã đã quá 120s hoặc đã được nhận phiên trước đó
    if (!rawData) {
      throw new AppError(
        410,
        'QR_EXPIRED',
        'Mã QR đã hết hạn hoặc phiên đăng nhập không tồn tại. Vui lòng tạo mã mới.'
      )
    }

    const data: QrSessionData = JSON.parse(rawData)

    // Kiểm tra tính hợp lệ của pollSecret (chống kẻ khác nhìn lén hoặc cướp phiên)
    if (!pollSecret || pollSecret !== data.pollSecret) {
      throw new AppError(403, 'FORBIDDEN', 'Mã bí mật tra cứu (pollSecret) không chính xác')
    }

    // Trường hợp 1: Người dùng chưa quét hoặc đang xem trên điện thoại
    if (data.status === 'PENDING') {
      return {
        status: 'PENDING'
      }
    }

    // Trường hợp 2: Người dùng từ chối xác nhận trên điện thoại
    if (data.status === 'REJECTED') {
      await redisClient.del(key)
      return {
        status: 'REJECTED'
      }
    }

    // Trường hợp 3: Người dùng ĐÃ XÁC NHẬN THÀNH CÔNG trên điện thoại
    if (data.status === 'APPROVED' && data.userId) {
      // 1. Tìm thông tin người dùng từ Database
      const user = await prisma.user.findUnique({
        where: { id: data.userId }
      })

      if (!user) {
        await redisClient.del(key)
        throw new AppError(404, 'USER_NOT_FOUND', 'Không tìm thấy thông tin tài khoản')
      }

      // 2. Ký Access Token mới (15 phút)
      const accessToken = jwt.sign(
        { userId: user.id, role: user.role },
        env.accessTokenSecret,
        { expiresIn: ACCESS_TOKEN_EXPIRATION }
      )

      // 3. Sinh Refresh Token mới (64 bytes ngẫu nhiên) và lưu vào bảng Session
      const rawRefreshToken = crypto.randomBytes(64).toString('hex')
      const tokenHash = hashToken(rawRefreshToken)

      await prisma.session.create({
        data: {
          refreshToken: tokenHash,
          expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRATION_MS),
          userId: user.id
        }
      })

      // 4. QUAN TRỌNG NHẤT: Xóa ngay mã QR khỏi Redis!
      // Đảm bảo chỉ cấp phiên đúng 1 lần duy nhất. Nếu Web gọi lại lần 2 sẽ nhận ngay lỗi 410.
      await redisClient.del(key)

      return {
        status: 'APPROVED',
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
    }

    throw new AppError(400, 'INVALID_QR_STATE', 'Trạng thái phiên QR không hợp lệ')
  },

  /**
   * 3. Ứng dụng di động (Mobile) quét mã và xác nhận đăng nhập (POST /api/auth/qr-login/confirm)
   * Sử dụng lệnh Lua script nguyên tử trong Redis để đảm bảo:
   * - So khớp đúng mã nonce
   * - Nếu 2 điện thoại cùng bấm xác nhận 1 mã QR thì chỉ 1 máy thành công
   */
  confirmQr: async (userId: string, input: { qrId: string; nonce: string }) => {
    const key = `qr:${input.qrId}`

    // Lua script thực hiện kiểm tra và cập nhật nguyên tử 100% trên Redis
    const luaScript = `
      local val = redis.call('GET', KEYS[1])
      if not val then
        return -1 -- Hết hạn hoặc không tồn tại (410)
      end
      local data = cjson.decode(val)
      if data.status ~= 'PENDING' then
        return -2 -- Đã được xử lý trước đó (409)
      end
      if data.nonce ~= ARGV[1] then
        return -3 -- Nonce không khớp (403)
      end
      data.status = 'APPROVED'
      data.userId = ARGV[2]
      redis.call('SET', KEYS[1], cjson.encode(data), 'EX', ARGV[3])
      return 1 -- Thành công
    `

    const result = await redisClient.eval(
      luaScript,
      1,
      key,
      input.nonce,
      userId,
      QR_APPROVED_TTL_SECONDS
    )

    if (result === -1) {
      throw new AppError(410, 'QR_EXPIRED', 'Mã QR đã hết hạn hoặc không tồn tại')
    }
    if (result === -2) {
      throw new AppError(409, 'QR_ALREADY_PROCESSED', 'Mã QR này đã được xác nhận trước đó')
    }
    if (result === -3) {
      throw new AppError(403, 'INVALID_NONCE', 'Mã xác thực nonce không chính xác')
    }

    return {
      message: 'Xác nhận đăng nhập qua mã QR thành công'
    }
  }
}

