import { Request, Response, NextFunction } from 'express'
import { ZodSchema, ZodError } from 'zod'

export const validate = (schema: ZodSchema) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validData = (await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params
      })) as any

      req.body = validData.body
      if (validData.query) {
        Object.defineProperty(req, 'query', { value: validData.query, writable: true, configurable: true })
      }
      if (validData.params) {
        Object.defineProperty(req, 'params', { value: validData.params, writable: true, configurable: true })
      }

      return next()
    } catch (error) {
      if (error instanceof ZodError || (error && (error as any).name === 'ZodError')) {
        const issues = (error as any).issues || (error as any).errors || []
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: issues[0]?.message || 'Invalid request data',
            details: issues
          }
        })
      }
      next(error)
    }
  }
}
