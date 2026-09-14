
import { Request, Response, NextFunction } from 'express'

export const sanitizeHeaders = (req: Request, _res: Response, next: NextFunction) => {
    // Luôn dọn dẹp sạch sẽ các header nội bộ nhạy cảm trước khi xử lý
    delete req.headers['x-user-id']
    delete req.headers['x-user-role']
    delete req.headers['x-gateway-verified']
    next()
}
