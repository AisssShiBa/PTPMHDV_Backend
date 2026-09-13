import {
  Body,
  Controller,
  Inject,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseGuards
} from '@nestjs/common'
import { Response } from 'express'
import { InternalApiKeyGuard } from '../common/internal-api-key.guard'
import {
  CreateWalletDto,
  CreditDto,
  DebitDto,
  HistoryQueryDto,
  HoldDto,
  OwnerIdParamDto,
  OwnerTypeQueryDto,
  ReferenceDto,
  TransferDto
} from './dto'
import { decimalToString, walletView, WalletService } from './wallet.service'

@UseGuards(InternalApiKeyGuard)
@Controller('internal/wallets')
export class WalletController {
  constructor(@Inject(WalletService) private readonly walletService: WalletService) {}

  @Post()
  async create(
    @Body() dto: CreateWalletDto,
    @Res({ passthrough: true }) response: Response
  ) {
    const result = await this.walletService.createWallet(dto)
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK)
    return { ...walletView(result.wallet), created: result.created }
  }

  @Get(':userId/balance')
  async getBalance(@Param() params: OwnerIdParamDto, @Query() query: OwnerTypeQueryDto) {
    const wallet = await this.walletService.getBalance(params.userId, query.ownerType)
    return {
      balance: decimalToString(wallet.balance),
      heldBalance: decimalToString(wallet.heldBalance),
      availableBalance: decimalToString(wallet.balance.sub(wallet.heldBalance)),
      currency: wallet.currency,
      status: wallet.status
    }
  }

  @Post(':userId/hold')
  @HttpCode(HttpStatus.OK)
  async hold(
    @Param() params: OwnerIdParamDto,
    @Body() dto: HoldDto,
    @Query() query: OwnerTypeQueryDto
  ) {
    const { hold, replayed } = await this.walletService.createHold(
      params.userId,
      dto.amount,
      dto.referenceId,
      dto.expiresAt,
      query.ownerType
    )
    return {
      id: hold.id,
      amount: decimalToString(hold.amount),
      referenceId: hold.referenceId,
      status: hold.status,
      expiresAt: hold.expiresAt.toISOString(),
      replayed
    }
  }

  @Post(':userId/capture')
  @HttpCode(HttpStatus.OK)
  async capture(
    @Param() params: OwnerIdParamDto,
    @Body() dto: ReferenceDto,
    @Query() query: OwnerTypeQueryDto
  ) {
    const result = await this.walletService.captureHold(
      params.userId,
      dto.referenceId,
      query.ownerType
    )
    return {
      balance: decimalToString(result.balance),
      transactionId: result.transactionId,
      replayed: result.replayed
    }
  }

  @Post(':userId/release')
  @HttpCode(HttpStatus.OK)
  async release(
    @Param() params: OwnerIdParamDto,
    @Body() dto: ReferenceDto,
    @Query() query: OwnerTypeQueryDto
  ) {
    const { hold, replayed } = await this.walletService.releaseHold(
      params.userId,
      dto.referenceId,
      query.ownerType
    )
    return { id: hold.id, status: hold.status, replayed }
  }

  @Post('transfer')
  @HttpCode(HttpStatus.OK)
  async transfer(@Body() dto: TransferDto) {
    const result = await this.walletService.transfer(dto)
    return {
      fromBalance: decimalToString(result.sourceWallet.balance),
      toBalance: decimalToString(result.destinationWallet.balance),
      transactionId: result.transactionId,
      replayed: result.replayed
    }
  }

  @Post(':userId/credit')
  @HttpCode(HttpStatus.OK)
  async credit(
    @Param() params: OwnerIdParamDto,
    @Body() dto: CreditDto,
    @Query() query: OwnerTypeQueryDto
  ) {
    const result = await this.walletService.credit(params.userId, dto, query.ownerType)
    return {
      balance: decimalToString(result.destinationWallet.balance),
      transactionId: result.transactionId,
      replayed: result.replayed
    }
  }

  @Post(':userId/debit')
  @HttpCode(HttpStatus.OK)
  async debit(
    @Param() params: OwnerIdParamDto,
    @Body() dto: DebitDto,
    @Query() query: OwnerTypeQueryDto
  ) {
    const result = await this.walletService.debit(params.userId, dto, query.ownerType)
    return {
      balance: decimalToString(result.sourceWallet.balance),
      transactionId: result.transactionId,
      replayed: result.replayed
    }
  }

  @Get(':userId/history')
  async history(
    @Param() params: OwnerIdParamDto,
    @Query() query: HistoryQueryDto
  ) {
    const result = await this.walletService.getHistory(params.userId, query)
    return {
      items: result.entries.map((entry) => ({
        id: entry.id.toString(),
        transactionId: entry.transactionId,
        direction: entry.direction,
        amount: decimalToString(entry.amount),
        balanceAfter: decimalToString(entry.balanceAfter),
        referenceId: entry.referenceId,
        transferType: entry.transferType,
        note: entry.note,
        createdAt: entry.createdAt.toISOString()
      })),
      total: result.total,
      page: result.page,
      limit: result.limit,
      from: result.from.toISOString(),
      to: result.to.toISOString()
    }
  }
}
