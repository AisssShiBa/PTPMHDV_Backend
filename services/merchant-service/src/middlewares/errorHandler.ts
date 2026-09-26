import { Response, NextFunction } from 'express'
import { ZodError } from 'zod'
import { RequestWithContext } from './requestId'
import { HttpError } from '../utils/errors'

export function errorHandler(error: unknown, req: RequestWithContext, res: Response, _next: NextFunction) {
  let status = 500, code = 'INTERNAL_SERVER_ERROR', message = 'Internal server error'
  if (error instanceof HttpError) ({ status, code, message } = error)
  else if (error instanceof ZodError) {
    status = 400; code = 'VALIDATION_ERROR'; message = error.issues[0]?.message || 'Invalid input'
  } else {
    const known = error as { code?: string; type?: string; status?: number }
    if (known.code === 'P2002') { status = 409; code = 'DUPLICATE_RESOURCE'; message = 'Resource already exists' }
    if (known.code === 'P2025') { status = 404; code = 'NOT_FOUND'; message = 'Resource not found' }
    if (known.code === 'LIMIT_FILE_SIZE') { status = 413; code = 'FILE_TOO_LARGE'; message = 'Maximum upload size is 5 MiB' }
    else if (known.code?.startsWith('LIMIT_')) { status = 400; code = 'INVALID_UPLOAD'; message = 'Invalid upload fields' }
    if (known.type === 'entity.parse.failed') { status = 400; code = 'VALIDATION_ERROR'; message = 'Invalid JSON' }
    if (known.type === 'entity.too.large') { status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Payload too large' }
  }
  if (status >= 500) console.error(JSON.stringify({ requestId: req.requestId, method: req.method, code, status }))
  return res.status(status).json({ success: false, error: { code, message }, requestId: req.requestId })
}
