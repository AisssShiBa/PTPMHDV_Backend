// D:\PTPMHDV\Backend\gateway\src\middlewares\requestId.ts
import { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'crypto'

export const attachRequestId = (req: Request, res: Response, next: NextFunction) => {
    // Tận dụng ID sẵn có từ client/load balancer nếu có, nếu không tự sinh UUID v4 mới
    const requestId = (req.headers['x-request-id'] as string) || randomUUID()

    // Gán vào req.headers để proxy tự động đẩy tiếp sang service con
    req.headers['x-request-id'] = requestId

    // Trả ngược lại header cho client để họ có mã tra cứu khi gặp sự cố
    res.setHeader('x-request-id', requestId)

    next()
}
