import { OwnerType, Prisma, PrismaClient, SystemWalletCode, WalletStatus } from "@prisma/client";
import { DomainException } from "../utils/domain.exception";
import { CreateWalletDto, HistoryQueryDto, ListWalletsDto } from "../dtos/wallet.dto";
import { decimalToString } from "../utils/wallet.helpers";
import { decodeCursor, encodeCursor, KeysetCursor } from "../utils/cursor.helper";

const HttpStatus = { NOT_FOUND: 404, BAD_REQUEST: 400, INTERNAL_SERVER_ERROR: 500 };
const prisma = new PrismaClient();

export class WalletService {
  constructor() {
    // System wallets are seeded via migration, no runtime creation
  }

  async createWallet(dto: CreateWalletDto) {
    const ownerType = dto.ownerType ?? OwnerType.USER;
    if (ownerType === OwnerType.SYSTEM) {
      throw new DomainException(HttpStatus.BAD_REQUEST, "INVALID_OWNER_TYPE", "SYSTEM wallets are managed by wallet-service only");
    }

    return await prisma.$transaction(async (tx) => {
      const existing = await tx.wallet.findUnique({
        where: { userId_ownerType: { userId: dto.userId, ownerType } }
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

  async getBalance(userId: string, ownerType: OwnerType = OwnerType.USER, systemCode?: SystemWalletCode) {
    let where: Prisma.WalletWhereInput;
    if (systemCode) {
      where = { systemCode };
    } else {
      where = { userId, ownerType };
    }

    const wallet = await prisma.wallet.findFirst({
      where
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

  async getMeLedger(userId: string, options: { cursor?: string; limit?: number }) {
    const wallet = await prisma.wallet.findFirst({
      where: { userId, ownerType: OwnerType.USER },
    });
    if (!wallet) {
      throw new DomainException(HttpStatus.NOT_FOUND, "WALLET_NOT_FOUND", "Wallet was not found");
    }

    let parsedCursor: KeysetCursor | undefined;
    if (options.cursor) {
      parsedCursor = decodeCursor(options.cursor);
    }

    const limit = options.limit ?? 20;

    const where: Prisma.LedgerEntryWhereInput = {
      walletId: wallet.id,
      ...(parsedCursor
        ? {
            OR: [
              { createdAt: { lt: parsedCursor.createdAt } },
              {
                AND: [
                  { createdAt: parsedCursor.createdAt },
                  { id: { lt: parsedCursor.id } },
                ],
              },
            ],
          }
        : {}),
    };

    const entries = await prisma.ledgerEntry.findMany({
      where,
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: limit + 1,
    });

    const hasNextPage = entries.length > limit;
    const items = hasNextPage ? entries.slice(0, limit) : entries;
    const nextCursor = hasNextPage && items.length > 0
      ? encodeCursor(items[items.length - 1])
      : null;

    return {
      items: items.map((entry) => ({
        id: entry.id.toString(),
        transactionId: entry.transactionId,
        direction: entry.direction,
        amount: decimalToString(entry.amount),
        balanceAfter: decimalToString(entry.balanceAfter),
        referenceId: entry.referenceId,
        transferType: entry.transferType,
        note: entry.note,
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor,
    };
  }

}
