import { Request, Response, NextFunction } from 'express'

interface InfraError extends Error {
  code?: string
  body?: unknown
}

export const errorHandler = (
  err: InfraError,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
) => {
  // Nếu headers đã được gửi thì không ghi đè response
  if (res.headersSent) {
    return
  }

  const requestId = (req as { requestId?: string }).requestId || req.headers['x-request-id']

  // Prisma P2025 — record không tồn tại
  if (err?.code === 'P2025') {
    return res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Không tìm thấy tài nguyên yêu cầu'
      },
      requestId
    })
  }

  // Lỗi định dạng JSON gửi lên bị sai cú pháp
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

  console.error('[NOTIFICATION ERROR]', {
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