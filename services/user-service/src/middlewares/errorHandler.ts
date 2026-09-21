import { Request, Response, NextFunction } from 'express'

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  const statusCode = err.status || err.statusCode || 500
  const code = err.code || (statusCode === 404 ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR')
  const message = err.message || 'Internal server error'

  if (statusCode >= 500) {
    console.error(`[Error] ${req.method} ${req.originalUrl}:`, err)
  }

  return res.status(statusCode).json({
    success: false,
    error: {
      code,
      message
    }
  })
}
