import { NextFunction, Request, Response } from 'express'
import { Prisma } from '@prisma/client'
import { HttpError } from '../errors'

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({
      code: error.code,
      message: error.message
    })
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      return res.status(409).json({
        code: 'CONFLICT',
        message: 'The requested resource already exists'
      })
    }

    if (error.code === 'P2025') {
      return res.status(404).json({
        code: 'NOT_FOUND',
        message: 'The requested resource was not found'
      })
    }

    if (error.code === 'P2003') {
      return res.status(404).json({
        code: 'USER_NOT_FOUND',
        message: 'The referenced user was not found'
      })
    }
  }

  console.error(error)
  return res.status(500).json({
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred'
  })
}
