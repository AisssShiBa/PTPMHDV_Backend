// D:\PTPMHDV\Backend\gateway\src\middlewares\sanitizeHeaders.ts
import { Request, Response, NextFunction } from 'express'

/**
 * MIDDLEWARE LÀM SẠCH HEADER (BẢO VỆ CHỐNG HEADER SPOOFING)
 * 
 * Mục đích:
 * Client bên ngoài Internet có thể tự chèn các header nhạy cảm nhằm giả mạo danh tính.
 * Middleware này chạy ĐẦU TIÊN trong chuỗi xử lý để xóa sổ sạch sẽ các header nội bộ đó.
 */
export const sanitizeHeaders = (req: Request, _res: Response, next: NextFunction): void => {
    // 1. Xóa Gateway Token do client tự chế (nếu có)
    delete req.headers['x-gateway-token']

    // 2. Xóa cờ tĩnh cũ x-gateway-verified (chống giả mạo hệ thống cũ)
    delete req.headers['x-gateway-verified']

    // 3. Xóa các header thông tin người dùng do client tự điền
    delete req.headers['x-user-id']
    delete req.headers['x-user-role']

    next()
}
