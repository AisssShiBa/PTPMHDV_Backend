import { Request, Response, NextFunction } from 'express'

/**
 * Hàm tạo lỗi nhanh (Dùng hàm thuần, KHÔNG DÙNG CLASS)
 * Ví dụ khi cần ném lỗi: next(createError(400, 'INVALID_INPUT', 'Dữ liệu không hợp lệ'))
 */
export function createError(status: number, code: string, message: string) {
  return { status, code, message }
}

/**
 * Middleware bắt lỗi toàn cục của Express
 * Bất kỳ khi nào có lỗi xảy ra, Express sẽ tự động chuyển dữ liệu vào hàm này.
 */
export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) {
  // 1. Mã trạng thái HTTP (400, 403, 404, mặc định là 500)
  const status = err.status || err.statusCode || 500

  // 2. Tên mã lỗi (mặc định là 'INTERNAL_SERVER_ERROR')
  const code = err.code || 'INTERNAL_SERVER_ERROR'

  // 3. Lời nhắn lỗi
  const message = err.message || 'Đã xảy ra lỗi tại máy chủ'

  // 4. In thông báo lỗi ra terminal
  console.error(`❌ [LỖI] ${req.method} ${req.url} -> [${code}] ${status}: ${message}`)

  // 5. Trả kết quả JSON về cho Frontend
  return res.status(status).json({
    success: false,
    error: {
      code,
      message
    }
  })
}
