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
      req.query = validData.query;
      req.params = validData.params;

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
