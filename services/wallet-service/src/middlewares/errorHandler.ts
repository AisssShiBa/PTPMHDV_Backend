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

  // Handle Prisma constraint violation
  if (err?.code === 'P2004' || err?.code === '23514') {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INSUFFICIENT_BALANCE_OR_INVALID_STATE',
        message: 'Transaction failed due to balance or state constraints',
      }
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
