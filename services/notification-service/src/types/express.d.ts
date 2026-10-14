import { Request } from 'express'

// Mở rộng Express Request: req.userId được gán bởi clientAuth
// (lấy từ req.auth.userId sau khi kiểm tra chữ ký Gateway Token).
declare global {
  namespace Express {
    interface Request {
      userId?: string
    }
  }
}

// Giữ file này là module (tránh biến thành global script)
export {}
