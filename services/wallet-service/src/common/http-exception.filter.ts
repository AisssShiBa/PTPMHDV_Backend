import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { Request, Response } from 'express'

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>()
    const request = host.switchToHttp().getRequest<Request>()
    let status = HttpStatus.INTERNAL_SERVER_ERROR
    let code = 'INTERNAL_ERROR'
    let message = 'An unexpected error occurred'

    if (exception instanceof HttpException) {
      status = exception.getStatus()
      const body = exception.getResponse()
      if (typeof body === 'object' && body !== null) {
        const value = body as { code?: string; message?: string | string[] }
        code = value.code ?? (status === 400 ? 'INVALID_INPUT' : 'HTTP_ERROR')
        message = Array.isArray(value.message)
          ? value.message.join(', ')
          : (value.message ?? message)
      } else if (typeof body === 'string') {
        message = body
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT
        code = 'CONFLICT'
        message = 'The resource already exists'
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND
        code = 'NOT_FOUND'
        message = 'The resource was not found'
      }
    }

    if (status >= 500) {
      console.error(exception)
    }

    response.status(status).json({
      code,
      message,
      path: request.url,
      timestamp: new Date().toISOString()
    })
  }
}
