import { OwnerType, PrismaClient, WalletStatus } from "@prisma/client";
import { DomainException } from "../utils/domain.exception";
import { CreateWalletDto, HistoryQueryDto, ListWalletsDto } from "../dtos/wallet.dto";

const HttpStatus = { NOT_FOUND: 404, BAD_REQUEST: 400, INTERNAL_SERVER_ERROR: 500 };
const prisma = new PrismaClient();

export class WalletService {
  constructor() {
    this.ensureSystemWallet();
  }

  private async ensureSystemWallet() {
    try {
      const existing = await prisma.wallet.findFirst({
        where: { ownerType: OwnerType.SYSTEM }
      });
      if (!existing) {
        await prisma.wallet.create({
          data: {
            userId: null,
            ownerType: OwnerType.SYSTEM,
            currency: "VND",
            status: WalletStatus.ACTIVE,
          }
        });
      }
    } catch (e) {
      console.error('Failed to create SYSTEM wallet', e);
    }
  }

  async createWallet(dto: CreateWalletDto) {
    const ownerType = dto.ownerType ?? OwnerType.USER;
    if (ownerType === OwnerType.SYSTEM) {
      throw new DomainException(HttpStatus.BAD_REQUEST, "INVALID_OWNER_TYPE", "SYSTEM wallets are managed by wallet-service only");
    }

    return await prisma.$transaction(async (tx) => {
      const existing = await tx.wallet.findFirst({
        where: { userId: dto.userId, ownerType }
      });
      if (existing) {
        return { wallet: existing, created: false };
      }

      const wallet = await tx.wallet.create({
        data: {
          userId: dto.userId,
          ownerType,
          currency: dto.currency ?? "VND",
          status: WalletStatus.ACTIVE,
        }
      });
      return { wallet, created: true };
    });
  }

  async getBalance(userId: string, ownerType: OwnerType = OwnerType.USER) {
    const wallet = await prisma.wallet.findFirst({
      where: { userId, ownerType }
    });
    if (!wallet) throw new DomainException(HttpStatus.NOT_FOUND, "WALLET_NOT_FOUND", "Wallet was not found");
    return wallet;
  }

  async getHistory(userId: string, query: HistoryQueryDto) {
    const ownerType = query.ownerType ?? OwnerType.USER;
    const wallet = await prisma.wallet.findFirst({ where: { userId, ownerType } });
    if (!wallet) throw new DomainException(HttpStatus.NOT_FOUND, "WALLET_NOT_FOUND", "Wallet was not found");

    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [entries, total] = await Promise.all([
      prisma.ledgerEntry.findMany({
        where: {
          walletId: wallet.id,
          createdAt: { gte: from, lte: to }
        },
        orderBy: { id: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.ledgerEntry.count({
        where: {
          walletId: wallet.id,
          createdAt: { gte: from, lte: to }
        }
      })
    ]);

    const serializedEntries = entries.map(e => ({
      ...e,
      id: e.id.toString(),
    }));

    return { entries: serializedEntries, total, page, limit, from, to };
  }

  async listWallets(query: ListWalletsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: any = {};
    if (query.userId) where.userId = query.userId;
    if (query.ownerType) where.ownerType = query.ownerType;
    if (query.status) where.status = query.status;

    const [wallets, total] = await Promise.all([
      prisma.wallet.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.wallet.count({ where })
    ]);

    return { wallets, total, page, limit };
  }

  async reconcile() {
    throw new DomainException(HttpStatus.INTERNAL_SERVER_ERROR, "NOT_IMPLEMENTED", "Reconciliation with real DB requires batch aggregation");
  }
}
