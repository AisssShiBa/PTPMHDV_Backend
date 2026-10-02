import { LedgerDirection, OwnerType, PrismaClient, TransferType, WalletStatus } from "@prisma/client";
import { DomainException } from "../utils/domain.exception";
import { money } from "../utils/wallet.helpers";
import { LedgerService } from "./ledger.service";
import { AdjustDto } from "../dtos/wallet.dto";

const HttpStatus = { NOT_FOUND: 404 };
const prisma = new PrismaClient();

export class WalletAdminService {
  constructor(private readonly ledgerService: LedgerService) {}

  async adjust(userId: string, dto: AdjustDto, ownerType: OwnerType = OwnerType.USER) {
    const amount = money(dto.amount);
    const userIsSource = dto.direction === LedgerDirection.DEBIT;

    return await prisma.$transaction(async (tx) => {
      const userWallet = await this.ledgerService.findWalletTx(tx, userId, ownerType);
      const systemWallet = await this.ledgerService.getSystemWalletTx(tx);

      return await this.ledgerService.moveMoneyTxInternal(tx, {
        fromWallet: userIsSource ? userWallet : systemWallet,
        toWallet: userIsSource ? systemWallet : userWallet,
        amount,
        referenceId: dto.referenceId,
        transferType: TransferType.ADJUSTMENT,
        note: dto.reason,
        bypassLockedFrom: userIsSource,
      });
    });
  }

  async setLock(userId: string, locked: boolean, ownerType: OwnerType = OwnerType.USER) {
    const status = locked ? WalletStatus.LOCKED : WalletStatus.ACTIVE;
    const wallet = await prisma.wallet.findFirst({ where: { userId, ownerType } });
    if (!wallet) throw new DomainException(HttpStatus.NOT_FOUND, "WALLET_NOT_FOUND", "Wallet was not found");

    return await prisma.wallet.update({
      where: { id: wallet.id },
      data: { status }
    });
  }
}
