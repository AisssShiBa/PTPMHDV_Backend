import { Request, Response, NextFunction } from 'express'

export const sanitizeHeaders = (req: Request, _res: Response, next: NextFunction) => {
    // Xóa sạch các header bảo mật nội bộ do client bên ngoài truyền vào
    delete req.headers['x-user-id']
    delete req.headers['x-user-role']
    delete req.headers['x-gateway-verified']
    next()
}
