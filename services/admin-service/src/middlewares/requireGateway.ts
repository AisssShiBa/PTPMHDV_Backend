import { Response, NextFunction } from 'express'
import { RequestWithContext } from './requestId'
import { env } from '../config/env'

export function requireGateway(req: RequestWithContext, res: Response, next: NextFunction) {
  // Cho phép bypass khi dev kiểm thử cục bộ bằng cờ DISABLE_GATEWAY_CHECK=true
  if (env.disableGatewayCheck) {
    return next()
  }

  // Yêu cầu: Phải đi qua API Gateway (được đóng dấu x-gateway-verified) HOẶC là cuộc gọi nội bộ hợp lệ
  if (req.isGatewayVerified || req.isInternalCall) {
    return next()
  }

  return res.status(403).json({
    success: false,
    error: {
      code: 'FORBIDDEN',
      message: 'Truy cập bị từ chối: Yêu cầu phải được định tuyến qua API Gateway hoặc có khóa nội bộ hợp lệ'
    }
  })
}
