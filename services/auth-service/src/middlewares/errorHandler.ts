import { Request, Response, NextFunction } from 'express'
import { ZodError } from 'zod'
import { AppError } from '../utils/errors'

export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  // Nếu headers đã được gửi thì không ghi đè response
  if (res.headersSent) {
    return
  }

  const requestId = (req as any).requestId || req.headers['x-request-id']

  // 1. Lỗi do lập trình viên định nghĩa qua AppError
  if (err instanceof AppError) {
    return res.status(err.status).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details
      },
      requestId
    })
  }

  // 2. Lỗi do Zod validation ném ra
  if (err instanceof ZodError) {
    const firstIssue = err.issues[0]
    const message = firstIssue ? `${firstIssue.path.join('.')}: ${firstIssue.message}` : 'Dữ liệu đầu vào không hợp lệ'
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message
      },
      requestId
    })
  }

  // 3. Lỗi do Prisma ném ra (P2002: Trùng lặp trường duy nhất)
  if (err.code === 'P2002') {
    const target = (err.meta?.target as string[])?.join(', ') || 'Tài nguyên'
    return res.status(409).json({
      success: false,
      error: {
        code: 'DUPLICATE_RESOURCE',
        message: `${target} đã được sử dụng trong hệ thống`
      },
      requestId
    })
  }

  // 4. Lỗi định dạng JSON gửi lên bị sai cú pháp
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_JSON',
        message: 'Định dạng JSON gửi lên không hợp lệ'
      },
      requestId
    })
  }

  // 5. Lỗi hệ thống ngoài dự kiến (500)
  console.error('[AUTH ERROR]', {
    requestId,
    message: err?.message || err,
    stack: process.env.NODE_ENV !== 'production' ? err?.stack : undefined
  })

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Đã xảy ra lỗi hệ thống, vui lòng thử lại sau'
    },
    requestId
  })
}
