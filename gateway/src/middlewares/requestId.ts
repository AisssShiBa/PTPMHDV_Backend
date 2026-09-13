import { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'crypto'

export const attachRequestId = (req: Request, res: Response, next: NextFunction) => {
    // Nếu client hoặc load balancer đã có x-request-id thì dùng tiếp, ngược lại tự tạo UUID mới
    const requestId = (req.headers['x-request-id'] as string) || randomUUID()
    req.headers['x-request-id'] = requestId
    res.setHeader('x-request-id', requestId)
    next()
}
