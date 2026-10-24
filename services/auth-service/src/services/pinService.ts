import bcrypt from 'bcrypt'
import { prisma } from '../config/prisma'
import { AppError } from '../utils/errors'
import { SetupPinInput, VerifyPinInput, ChangePinInput } from '../validations/pinValidation'
import { signTransactionToken } from '../utils/transactionToken'

// Hằng số bảo mật cho mã PIN theo đặc tả Tuần 2
const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 30 * 60 * 1000 // 30 phút tính bằng milliseconds
const BCRYPT_SALT_ROUNDS = 10

export const PinService = {
  /**
   * 1. Cài đặt mã PIN lần đầu (Setup PIN)
   */
  setupPin: async (userId: string, input: SetupPinInput) => {
    // Kiểm tra tài khoản người dùng có tồn tại
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { pin: true }
    })

    if (!user) {
      throw new AppError(404, 'USER_NOT_FOUND', 'Không tìm thấy thông tin người dùng')
    }

    if (user.pin) {
      throw new AppError(409, 'PIN_ALREADY_EXISTS', 'Tài khoản đã được thiết lập mã PIN giao dịch. Vui lòng sử dụng tính năng đổi mã PIN.')
    }

    // Băm mã PIN với Bcrypt có Salt ngẫu nhiên
    const pinHash = await bcrypt.hash(input.pin, BCRYPT_SALT_ROUNDS)

    // Tạo bản ghi UserPin trong cơ sở dữ liệu
    await prisma.userPin.create({
      data: {
        userId,
        pinHash,
        failedAttempts: 0,
        lockedUntil: null
      }
    })

    return {
      message: 'Thiết lập mã PIN giao dịch thành công'
    }
  },

  /**
   * 2. Xác thực mã PIN giao dịch và cấp transactionToken (Verify PIN - Nhiệm vụ Đ7 & Đ8)
   * 
   * Quy tắc nghiệp vụ:
   * - Nếu tài khoản đang trong thời gian khóa (< 30 phút): Từ chối ngay với mã lỗi PIN_LOCKED
   * - Nhập sai: Tăng failedAttempts. Nếu chạm mốc 5 lần: Khóa 30 phút
   * - Nhập đúng: Reset số lần sai về 0, cấp transactionToken (ES256, 60s) gắn chặt paymentId và amount
   */
  verifyPin: async (userId: string, input: VerifyPinInput) => {
    const userPin = await prisma.userPin.findUnique({
      where: { userId }
    })

    if (!userPin) {
      throw new AppError(404, 'PIN_NOT_SETUP', 'Bạn chưa thiết lập mã PIN giao dịch. Vui lòng cài đặt mã PIN trước.')
    }

    const now = new Date()

    // Kiểm tra trạng thái khóa tài khoản
    if (userPin.lockedUntil && userPin.lockedUntil > now) {
      const remainingSeconds = Math.ceil((userPin.lockedUntil.getTime() - now.getTime()) / 1000)
      throw new AppError(
        423,
        'PIN_LOCKED',
        `Mã PIN đã bị khóa do nhập sai quá ${MAX_FAILED_ATTEMPTS} lần liên tiếp. Vui lòng thử lại sau ${Math.ceil(remainingSeconds / 60)} phút.`,
        {
          lockedUntil: userPin.lockedUntil,
          remainingSeconds
        }
      )
    }

    // So khớp mã PIN người dùng gửi lên với pinHash trong database
    const isMatch = await bcrypt.compare(input.pin, userPin.pinHash)

    if (!isMatch) {
      // Nếu đã hết hạn khóa trước đó thì tính lại từ 1, ngược lại tăng tiếp
      const isLockExpired = userPin.lockedUntil && userPin.lockedUntil <= now
      const currentAttempts = isLockExpired ? 0 : userPin.failedAttempts
      const nextAttempts = currentAttempts + 1

      if (nextAttempts >= MAX_FAILED_ATTEMPTS) {
        // Chạm ngưỡng 5 lần: Tiến hành khóa 30 phút
        const lockedUntil = new Date(now.getTime() + LOCKOUT_DURATION_MS)

        await prisma.userPin.update({
          where: { userId },
          data: {
            failedAttempts: nextAttempts,
            lockedUntil
          }
        })

        throw new AppError(
          423,
          'PIN_LOCKED',
          `Bạn đã nhập sai mã PIN ${MAX_FAILED_ATTEMPTS} lần liên tiếp. Chức năng giao dịch bị tạm khóa 30 phút.`,
          {
            lockedUntil,
            remainingSeconds: 30 * 60
          }
        )
      } else {
        // Cập nhật số lần nhập sai
        await prisma.userPin.update({
          where: { userId },
          data: {
            failedAttempts: nextAttempts,
            lockedUntil: null
          }
        })

        const remainingAttempts = MAX_FAILED_ATTEMPTS - nextAttempts
        throw new AppError(
          400,
          'INVALID_PIN',
          `Mã PIN không chính xác. Bạn còn ${remainingAttempts} lần thử.`,
          {
            remainingAttempts
          }
        )
      }
    }

    // NHẬP ĐÚNG MÃ PIN:
    // Reset số lần sai và thời gian khóa nếu trước đó có ghi nhận
    if (userPin.failedAttempts > 0 || userPin.lockedUntil !== null) {
      await prisma.userPin.update({
        where: { userId },
        data: {
          failedAttempts: 0,
          lockedUntil: null
        }
      })
    }

    // Sinh transactionToken có hiệu lực 60s ký bằng ES256
    const transactionToken = signTransactionToken(userId, input.paymentId, input.amount)

    return {
      transactionToken,
      expiresIn: 60, // 60 giây
      message: 'Xác thực mã PIN thành công'
    }
  },

  /**
   * 3. Đổi mã PIN giao dịch (Change PIN)
   */
  changePin: async (userId: string, input: ChangePinInput) => {
    const userPin = await prisma.userPin.findUnique({
      where: { userId }
    })

    if (!userPin) {
      throw new AppError(404, 'PIN_NOT_SETUP', 'Tài khoản chưa thiết lập mã PIN giao dịch.')
    }

    const now = new Date()

    // Nếu đang bị khóa thì không cho phép đổi PIN để tránh lách luật
    if (userPin.lockedUntil && userPin.lockedUntil > now) {
      const remainingSeconds = Math.ceil((userPin.lockedUntil.getTime() - now.getTime()) / 1000)
      throw new AppError(
        423,
        'PIN_LOCKED',
        'Tài khoản đang bị khóa mã PIN, không thể thực hiện đổi mã PIN lúc này.',
        { remainingSeconds }
      )
    }

    // Kiểm tra mã PIN cũ
    const isOldPinMatch = await bcrypt.compare(input.oldPin, userPin.pinHash)
    if (!isOldPinMatch) {
      throw new AppError(400, 'INVALID_OLD_PIN', 'Mã PIN hiện tại không chính xác')
    }

    // Băm mã PIN mới và cập nhật
    const newPinHash = await bcrypt.hash(input.newPin, BCRYPT_SALT_ROUNDS)

    await prisma.userPin.update({
      where: { userId },
      data: {
        pinHash: newPinHash,
        failedAttempts: 0,
        lockedUntil: null
      }
    })

    return {
      message: 'Đổi mã PIN giao dịch thành công'
    }
  },

  /**
   * 4. Kiểm tra trạng thái thiết lập PIN của người dùng
   * Dùng cho Frontend kiểm tra xem User đã có PIN chưa để hiển thị màn hình cài đặt hay nhập PIN
   */
  getPinStatus: async (userId: string) => {
    const userPin = await prisma.userPin.findUnique({
      where: { userId }
    })

    if (!userPin) {
      return {
        hasPin: false,
        isLocked: false,
        remainingLockSeconds: 0
      }
    }

    const now = new Date()
    const isLocked = !!(userPin.lockedUntil && userPin.lockedUntil > now)
    const remainingLockSeconds = isLocked
      ? Math.ceil((userPin.lockedUntil!.getTime() - now.getTime()) / 1000)
      : 0

    return {
      hasPin: true,
      isLocked,
      remainingLockSeconds
    }
  }
}
