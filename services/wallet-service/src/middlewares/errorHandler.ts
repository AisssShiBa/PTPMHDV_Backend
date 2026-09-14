import { Request, Response, NextFunction } from 'express';
import { DomainException } from '../utils/domain.exception';

export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (err instanceof DomainException) {
    return res.status(err.status).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
      },
    });
  }

  console.error(err);

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: err.message || 'Internal server error',
    },
  });
};
