import { HttpException, HttpStatus } from '@nestjs/common'

export class DomainException extends HttpException {
  constructor(status: HttpStatus, code: string, message: string) {
    super({ code, message }, status)
  }
}
