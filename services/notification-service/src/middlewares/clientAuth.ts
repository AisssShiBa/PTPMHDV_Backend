import { Request, Response, NextFunction } from 'express'

// ClientAuth — chỉ chấp nhận request ĐÃ ĐƯỢC GATEWAY xác thực JWT:
// Gateway gán header x-user-id + x-gateway-verified=after JWT ok.
// Service KHÔNG tự verify JWT (tránh lệch secret) — tin header Gateway.
export const clientAuth = (req: Request, res: Response, next: NextFunction) => {
  const gatewayVerified = req.headers['x-gateway-verified']
  const userId = req.headers['x-user-id'] as string | undefined

  if (gatewayVerified !== 'true' || !userId) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Yêu cầu phải được xác thực qua Gateway'
      }
    })
  }

  // Gắn userId (self-guard dùng req.userId ở controller)
  req.userId = userId

  return next()
}
