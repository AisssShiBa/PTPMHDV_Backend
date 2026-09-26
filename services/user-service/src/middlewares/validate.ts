import { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
export const validate = (schema: z.ZodType) => (req: Request, _res: Response, next: NextFunction) => {
  try {
    const data = schema.parse({ body: req.body, query: req.query, params: req.params }) as {
      body?: unknown; query?: unknown; params?: unknown
    }
    if (data.body !== undefined) req.body = data.body
    for (const key of ['query', 'params'] as const)
      if (data[key] !== undefined) Object.defineProperty(req, key, { value: data[key], writable: true, configurable: true })
    next()
  } catch (error) { next(error) }
}
