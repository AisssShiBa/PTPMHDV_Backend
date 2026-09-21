import { Request, Response, NextFunction } from 'express'
import { env } from '../config/env'
import { AppError } from '../utils/errors'

/**
 * Middleware bảo vệ microservice: Yêu cầu request phải đi qua API Gateway
 * hoặc mang theo X-Internal-Key hợp lệ từ các microservices nội bộ
 */
export const requireGateway = (req: Request, _res: Response, next: NextFunction) => {
  // Cho phép bypass khi dev kiểm thử cục bộ bằng cờ DISABLE_GATEWAY_CHECK=true
  if (env.disableGatewayCheck || env.nodeEnv === 'test') {
    return next()
  }

  const isGatewayVerified = req.headers['x-gateway-verified'] === 'true'
  const incomingKey = (req.headers['x-internal-key'] as string | undefined)?.trim()
  const isInternalKeyValid = Boolean(
    incomingKey &&
    env.internalApiKey &&
    incomingKey === env.internalApiKey.trim()
  )

  if (isGatewayVerified || isInternalKeyValid) {
    return next()
  }

  return next(
    new AppError(
      403,
      'FORBIDDEN',
      'Truy cập bị từ chối: Yêu cầu phải được định tuyến qua API Gateway hoặc có khóa nội bộ hợp lệ'
    )
  )
}
