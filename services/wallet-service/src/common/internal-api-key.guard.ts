import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable
} from '@nestjs/common'
import { timingSafeEqual } from 'crypto'
import { Request } from 'express'
import { env } from '../config/env'
import { DomainException } from './domain.exception'

@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!env.internalApiKey) {
      if (env.nodeEnv === 'production') {
        throw new DomainException(
          HttpStatus.SERVICE_UNAVAILABLE,
          'INTERNAL_AUTH_NOT_CONFIGURED',
          'Internal API authentication is not configured'
        )
      }

      return true
    }

    const request = context.switchToHttp().getRequest<Request>()
    const supplied = request.header('x-internal-key')
    const expected = env.internalApiKey
    const valid =
      Boolean(supplied) &&
      supplied!.length === expected.length &&
      timingSafeEqual(Buffer.from(supplied!), Buffer.from(expected))

    if (!valid) {
      throw new DomainException(
        HttpStatus.UNAUTHORIZED,
        'INTERNAL_AUTH_REQUIRED',
        'A valid internal API key is required'
      )
    }

    return true
  }
}
