import { Response } from 'express'
import { RequestWithContext } from './requestId'
export function notFound(req: RequestWithContext, res: Response) {
  return res.status(404).json({
    success: false, error: { code: 'NOT_FOUND', message: 'Route not found' }, requestId: req.requestId
  })
}
