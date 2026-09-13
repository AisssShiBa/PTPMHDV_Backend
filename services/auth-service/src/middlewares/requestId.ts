import { randomUUID } from 'crypto'
import { Request, Response, NextFunction } from 'express'

export const attachRequestId = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const requestId = (req.headers['x-request-id'] as string) || randomUUID()
  ;(req as any).requestId = requestId
  res.setHeader('X-Request-Id', requestId) // BỔ SUNG: trả lại cho client biết ID này
  next()
}
