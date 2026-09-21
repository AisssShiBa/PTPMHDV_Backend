import { Request, Response, NextFunction } from 'express'
import { ZodSchema } from 'zod'

/**
 * Middleware kiểm tra và validate dữ liệu request bằng Zod Schema
 * Tự động parse và gán dữ liệu đã chuẩn hóa lại vào req[source]
 */
export const validateRequest = (
  schema: ZodSchema,
  source: 'body' | 'query' | 'params' = 'body'
) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const parsed = schema.parse(req[source])
      req[source] = parsed
      next()
    } catch (error) {
      next(error)
    }
  }
}
