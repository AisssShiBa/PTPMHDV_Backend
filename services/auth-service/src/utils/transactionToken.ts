import crypto from 'crypto'
import fs from 'fs'
import jwt from 'jsonwebtoken'
import { AppError } from './errors'

/* ==========================================================================
   1. ĐỊNH NGHĨA KIỂU DỮ LIỆU (INTERFACE)
   Mô tả các thông tin nghiệp vụ gắn chặt trong transactionToken (Tuần 2 - Đ8)
   ========================================================================== */
export interface TransactionTokenPayload {
  iss: string       // Đơn vị phát hành: 'finvault-auth-service'
  aud: string       // Nơi nhận: 'finvault-payment-service'
  sub: string       // ID người dùng xác thực (userId)
  paymentId: string // ID giao dịch thanh toán cụ thể
  amount: string    // Số tiền giao dịch (dạng chuỗi chống mất độ chính xác)
  jti: string       // UUID duy nhất của token (chống tấn công phát lại - Replay Attack)
  iat?: number      // Thời điểm sinh token (do jwt tự thêm)
  exp?: number      // Thời điểm hết hạn (60 giây)
}

/* ==========================================================================
   2. KHÓA MẬT MÃ CỐ ĐỊNH (DEV STUB CHO NGÀY 1 & 2)
   Cặp khóa ES256 (NIST P-256) độc lập của Auth-Txn dùng để dev/test nội bộ.
   Khoa (payment-service) có thể copy DEV_STUB_AUTH_TXN_PUBLIC_KEY để test verify.
   ========================================================================== */
export const DEV_STUB_AUTH_TXN_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg6GKcNCr3lS0mrl6q
qhVPZeMzDP4vOfOpB6kksaxu/NShRANCAARzRmfe75jG8vdRU7E0Vii8xFy4Pi4N
NA1JcmbRxSnSjg1ASP8C3cmhkyTdq8hHALTaQWPVJ15crDLbTaW2xlwC
-----END PRIVATE KEY-----`

export const DEV_STUB_AUTH_TXN_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEc0Zn3u+YxvL3UVOxNFYovMRcuD4u
DTQNSXJm0cUp0o4NQEj/At3JoZMk3avIRwC02kFj1SdeXKwy202ltsZcAg==
-----END PUBLIC KEY-----`

/* ==========================================================================
   3. HÀM HỖ TRỢ ĐỌC KHÓA (HELPER FUNCTIONS)
   Quy tắc: Ưu tiên đọc File Secret -> Biến môi trường -> Dùng khóa Dev Stub
   ========================================================================== */
export const getAuthTxnPrivateKey = (): string => {
  const keyPath = process.env.AUTH_TXN_PRIVATE_KEY_FILE
  if (keyPath && fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath, 'utf-8').trim()
  }

  if (process.env.AUTH_TXN_PRIVATE_KEY) {
    return process.env.AUTH_TXN_PRIVATE_KEY.trim()
  }

  if (process.env.NODE_ENV === 'production') {
    throw new AppError(500, 'INTERNAL_SERVER_ERROR', 'AUTH_TXN_PRIVATE_KEY is required in production')
  }

  return DEV_STUB_AUTH_TXN_PRIVATE_KEY
}

export const getAuthTxnPublicKey = (): string => {
  const keyPath = process.env.AUTH_TXN_PUBLIC_KEY_FILE
  if (keyPath && fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath, 'utf-8').trim()
  }

  if (process.env.AUTH_TXN_PUBLIC_KEY) {
    return process.env.AUTH_TXN_PUBLIC_KEY.trim()
  }

  if (process.env.NODE_ENV === 'production') {
    throw new AppError(500, 'INTERNAL_SERVER_ERROR', 'AUTH_TXN_PUBLIC_KEY is required in production')
  }

  return DEV_STUB_AUTH_TXN_PUBLIC_KEY
}

/**
 * Kiểm tra tính tương thích của cặp khóa ES256 khi khởi động ứng dụng
 */
export const validateTransactionKeys = (): void => {
  const privateKey = crypto.createPrivateKey(getAuthTxnPrivateKey())
  const publicKey = crypto.createPublicKey(getAuthTxnPublicKey())

  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('Auth-Txn signing requires an ES256 key (prime256v1)')
  }

  const derived = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString().trim()
  if (derived !== publicKey.export({ type: 'spki', format: 'pem' }).toString().trim()) {
    throw new Error('Auth-Txn public/private keys do not match')
  }

  if (process.env.NODE_ENV === 'production' && derived === DEV_STUB_AUTH_TXN_PUBLIC_KEY) {
    throw new Error('Development Auth-Txn key is not permitted in production')
  }
}

/* ==========================================================================
   4. HÀM KÝ TOKEN (CHÍNH - signTransactionToken)
   Được gọi khi người dùng xác thực mã PIN thành công.
   Token sống trong 60 giây và gắn chặt userId + paymentId + amount + jti.
   ========================================================================== */
export const signTransactionToken = (
  userId: string,
  paymentId: string,
  amount: string
): string => {
  if (!userId || !paymentId || !amount) {
    throw new AppError(400, 'INVALID_INPUT', 'userId, paymentId và amount là bắt buộc khi sinh transactionToken')
  }

  const payload: TransactionTokenPayload = {
    iss: 'finvault-auth-service',
    aud: 'finvault-payment-service',
    sub: userId,
    paymentId,
    amount,
    jti: crypto.randomUUID() // jti duy nhất chống Replay Attack
  }

  return jwt.sign(payload, getAuthTxnPrivateKey(), {
    algorithm: 'ES256',
    expiresIn: '60s' // Hạn sống chính xác 60 giây theo yêu cầu Tuần 2
  })
}

/* ==========================================================================
   5. HÀM KIỂM CHỨNG TOKEN (VERIFY - verifyTransactionToken)
   Dành cho payment-service hoặc auth-service kiểm tra tính hợp lệ của token.
   ========================================================================== */
export const verifyTransactionToken = (token: string): TransactionTokenPayload => {
  try {
    return jwt.verify(token, getAuthTxnPublicKey(), {
      algorithms: ['ES256'],
      issuer: 'finvault-auth-service',
      audience: 'finvault-payment-service'
    }) as TransactionTokenPayload
  } catch (error: any) {
    if (error.name === 'TokenExpiredError') {
      throw new AppError(401, 'TRANSACTION_TOKEN_EXPIRED', 'Mã xác thực giao dịch đã hết hạn (quá 60 giây)')
    }
    if (error.name === 'JsonWebTokenError') {
      throw new AppError(403, 'INVALID_TRANSACTION_TOKEN', 'Mã xác thực giao dịch không hợp lệ hoặc chữ ký đã bị thay đổi')
    }
    throw error
  }
}
