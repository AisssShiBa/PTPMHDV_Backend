import { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'crypto'
import { env } from '../config/env'

// Dùng Type gộp object đơn giản (Không dùng "interface extends" của hướng đối tượng)
export type RequestWithContext = Request & {
  requestId?: string
  userId?: string
  userRole?: string
  isInternalCall?: boolean
  isGatewayVerified?: boolean
}

// Viết bằng hàm mũi tên gán vào const (an toàn, ngắn gọn)
export const attachRequestId = (req: RequestWithContext, res: Response, next: NextFunction) => {
  // 1. Lấy mã vết x-request-id hoặc sinh mã ngẫu nhiên mới
  const incomingId = req.headers['x-request-id'] as string | undefined
  const requestId = incomingId || randomUUID()
  req.requestId = requestId
  res.setHeader('X-Request-Id', requestId)

  // 2. Xác thực xem có phải gọi nội bộ bằng khóa bí mật hay không
  const incomingKey = req.headers['x-internal-key'] as string | undefined
  req.isInternalCall = Boolean(
    incomingKey &&
    env.internalKey &&
    incomingKey.trim() === env.internalKey.trim()
  )

  // 3. Đánh dấu cờ Gateway xác thực
  req.isGatewayVerified = req.headers['x-gateway-verified'] === 'true'

  // 4. Lấy thông tin User do Gateway gửi kèm
  req.userId = (req.headers['x-user-id'] as string) || (req.headers['user-id'] as string) || undefined
  req.userRole = (req.headers['x-user-role'] as string) || (req.headers['user-role'] as string) || undefined

  // Chuyển sang middleware tiếp theo
  next()
}
