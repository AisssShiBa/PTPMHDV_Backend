import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

export const validate = (schema: ZodSchema) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validData = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      }) as any;
      
      // Override req with validated and transformed data
      req.body = validData.body;
      Object.defineProperty(req, 'query', { value: validData.query, writable: true, configurable: true });
      Object.defineProperty(req, 'params', { value: validData.params, writable: true, configurable: true });

      return next();
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          code: 'VALIDATION_ERROR',
          message: 'Invalid request data',
          details: (error as any).errors
        });
      }
      next(error);
    }
  };
};
