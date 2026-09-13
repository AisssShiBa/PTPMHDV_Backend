import { Controller, Post, Get, Body, Param, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { CheckoutDto, PaginationDto } from './dto';

@Controller('api/payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('checkout')
  @HttpCode(HttpStatus.CREATED)
  async checkout(@Body() dto: CheckoutDto) {
    return this.paymentService.checkout(dto);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(@Param('id') id: string) {
    return this.paymentService.confirm(id);
  }

  @Post(':id/refund')
  @HttpCode(HttpStatus.OK)
  async refund(@Param('id') id: string) {
    return this.paymentService.refund(id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(@Param('id') id: string) {
    return this.paymentService.cancel(id);
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.paymentService.getById(id);
  }

  @Get()
  async list(@Query() query: PaginationDto) {
    return this.paymentService.list(query.userId, query.type, query.status);
  }
}
