import { Request } from 'express'

// Mở rộng Express Request: req.userId được gán bởi clientAuth
// (đọc từ header x-user-id do Gateway tiêm sau khi xác thực JWT).
declare global {
  namespace Express {
    interface Request {
      userId?: string
    }
  }
}

// Giữ file này là module (tránh biến thành global script)
export {}
