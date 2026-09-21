import { Request, Response, NextFunction, RequestHandler } from 'express'

/**
 * Lớp lỗi chuẩn của ứng dụng, chứa HTTP status code và mã lỗi nghiệp vụ
 */
export class AppError extends Error {
  public status: number
  public code: string
  public details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
    Error.captureStackTrace(this, this.constructor)
  }
}

/**
 * Higher-Order Function bọc các controller async để tự động bắt lỗi và chuyển sang next(err)
 * Giúp controller không phải viết các khối try/catch lặp đi lặp lại
 */
export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}
