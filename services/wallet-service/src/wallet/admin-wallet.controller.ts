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
  UseGuards
} from '@nestjs/common'
import { InternalApiKeyGuard } from '../common/internal-api-key.guard'
import {
  AdjustDto,
  ListWalletsDto,
  OwnerIdParamDto,
  OwnerTypeQueryDto
} from './dto'
import { walletView, WalletService } from './wallet.service'

@UseGuards(InternalApiKeyGuard)
@Controller('admin')
export class AdminWalletController {
  constructor(@Inject(WalletService) private readonly walletService: WalletService) { }

  @Post('wallets/:userId/lock')
  @HttpCode(HttpStatus.OK)
  async lock(@Param() params: OwnerIdParamDto, @Query() query: OwnerTypeQueryDto) {
    return walletView(await this.walletService.setLock(params.userId, true, query.ownerType))
  }

  @Post('wallets/:userId/unlock')
  @HttpCode(HttpStatus.OK)
  async unlock(@Param() params: OwnerIdParamDto, @Query() query: OwnerTypeQueryDto) {
    return walletView(await this.walletService.setLock(params.userId, false, query.ownerType))
  }

  @Post('wallets/:userId/adjust')
  @HttpCode(HttpStatus.OK)
  async adjust(
    @Param() params: OwnerIdParamDto,
    @Body() dto: AdjustDto,
    @Query() query: OwnerTypeQueryDto
  ) {
    const result = await this.walletService.adjust(params.userId, dto, query.ownerType)
    return {
      userWallet: walletView(
        result.sourceWallet.userId === params.userId ? result.sourceWallet : result.destinationWallet
      ),
      transactionId: result.transactionId,
      replayed: result.replayed
    }
  }

  @Get('wallets')
  async list(@Query() query: ListWalletsDto) {
    const result = await this.walletService.listWallets(query)
    return {
      items: result.wallets.map(walletView),
      total: result.total,
      page: result.page,
      limit: result.limit
    }
  }

  @Get('reconciliation')
  async reconciliation() {
    const rows = await this.walletService.reconcile()
    return { discrepancies: rows.filter((row) => !row.matched), checked: rows.length }
  }
}
