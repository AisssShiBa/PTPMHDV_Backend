import { Response, NextFunction } from 'express'
import { ZodError } from 'zod'
import { RequestWithContext } from './requestId'
import { HttpError } from '../utils/errors'

export function errorHandler(
  error: unknown,
  req: RequestWithContext,
  res: Response,
  _next: NextFunction
) {
  let status = 500
  let code = 'INTERNAL_SERVER_ERROR'
  let message = 'Internal server error'

  if (error instanceof HttpError) {
    ;({ status, code, message } = error)
  } else if (error instanceof ZodError) {
    status = 400
    code = 'VALIDATION_ERROR'
    message = error.issues[0]?.message ?? 'Invalid input'
  } else {
    const known = error as { code?: string; type?: string }
    if (known.code === 'P2002') {
      status = 409
      code = 'DUPLICATE_RESOURCE'
      message = 'Resource already exists'
    }
    if (known.code === 'P2025') {
      status = 404
      code = 'NOT_FOUND'
      message = 'Resource not found'
    }
    if (known.type === 'entity.parse.failed') {
      status = 400
      code = 'VALIDATION_ERROR'
      message = 'Invalid JSON'
    }
  }

  if (status >= 500) {
    console.error(JSON.stringify({ requestId: req.requestId, method: req.method, code, status }))
  }
  return res.status(status).json({
    success: false,
    error: { code, message },
    requestId: req.requestId
  })
}
