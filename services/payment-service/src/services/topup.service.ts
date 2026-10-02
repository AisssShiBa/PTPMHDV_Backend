import { PrismaClient, TopupStatus } from '@prisma/client';
import { DomainException } from '../utils/domain.exception';
import { WalletClient } from '../clients/wallet.client';
import { randomBytes } from 'crypto';

const prisma = new PrismaClient();
const walletClient = new WalletClient();

export class TopupService {
  async createTopup(userId: string, amount: number) {
    const code = 'NAP' + randomBytes(4).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    const topup = await prisma.topupRequest.create({
      data: {
        userId,
        amount,
        code,
        expiresAt,
        status: TopupStatus.PENDING,
        auditLogs: {
          create: {
            actorId: userId,
            action: 'CREATE',
            toStatus: TopupStatus.PENDING,
          }
        }
      }
    });

    // Dummy bank info, can be from env
    const bankConfig = {
      bankName: 'VIETCOMBANK',
      accountNumber: '123456789',
      accountName: 'ADMIN PTPMHDV'
    };

    return {
      topup,
      paymentInfo: {
        ...bankConfig,
        amount,
        content: code,
        qrUrl: `https://img.vietqr.io/image/${bankConfig.bankName}-${bankConfig.accountNumber}-compact2.png?amount=${amount}&addInfo=${code}&accountName=${encodeURIComponent(bankConfig.accountName)}`
      }
    };
  }

  async getTopup(id: string, userId: string) {
    const topup = await prisma.topupRequest.findUnique({ where: { id } });
    if (!topup) throw new DomainException(404, 'NOT_FOUND', 'Topup request not found');
    if (topup.userId !== userId) throw new DomainException(403, 'FORBIDDEN', 'Access denied');
    return topup;
  }

  async getMyTopups(userId: string) {
    return prisma.topupRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });
  }

  async getAdminTopups(status?: string) {
    const whereClause = status ? { status: status as TopupStatus } : {};
    return prisma.topupRequest.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' }
    });
  }

  async approveTopup(id: string, adminId: string) {
    // 1. Move to PROCESSING safely
    const processingResult = await prisma.$executeRaw`
      UPDATE "TopupRequest"
      SET status = 'PROCESSING', "updatedAt" = NOW()
      WHERE id = ${id}::uuid AND status = 'PENDING'
    `;

    if (processingResult === 0) {
      throw new DomainException(409, 'CONFLICT', 'Topup request is not PENDING or already processed');
    }

    const topup = await prisma.topupRequest.findUnique({ where: { id } });
    if (!topup) throw new DomainException(404, 'NOT_FOUND', 'Topup request not found');

    // 2. Call Wallet service
    try {
      const walletRes = await walletClient.topupCredit(topup.userId, topup.amount.toString(), topup.code);
      
      if (!walletRes.success) {
        // Business logic error from wallet (e.g. invalid amount, locked wallet)
        const errorCode = walletRes.errorData?.error?.code;
        
        // Revert to PENDING if business error
        await prisma.topupRequest.update({
          where: { id },
          data: {
            status: TopupStatus.PENDING,
            auditLogs: {
              create: {
                actorId: adminId,
                action: 'REVERT_TO_PENDING',
                fromStatus: TopupStatus.PROCESSING,
                toStatus: TopupStatus.PENDING,
                reason: 'Wallet service returned error: ' + errorCode
              }
            }
          }
        });
        throw new DomainException(400, 'WALLET_ERROR', walletRes.errorData?.error?.message || 'Wallet credit failed');
      } else {
        // Success (wallet-service automatically handles idempotency and returns 200)
        await this.markAsApproved(id, adminId, walletRes.data?.data?.transactionId);
      }
    } catch (e: any) {
      if (e instanceof DomainException) throw e;
      // Network/Timeout error, keep in PROCESSING so admin can retry
      throw new DomainException(500, 'WALLET_NETWORK_ERROR', 'Failed to reach wallet service, please retry');
    }
  }

  private async markAsApproved(id: string, adminId: string, transactionId: string) {
    await prisma.topupRequest.update({
      where: { id },
      data: {
        status: TopupStatus.APPROVED,
        approvedBy: adminId,
        approvedAt: new Date(),
        walletTransactionId: transactionId,
        auditLogs: {
          create: {
            actorId: adminId,
            action: 'APPROVE',
            fromStatus: TopupStatus.PROCESSING,
            toStatus: TopupStatus.APPROVED
          }
        }
      }
    });
  }

  async rejectTopup(id: string, adminId: string, reason: string) {
    const result = await prisma.$executeRaw`
      UPDATE "TopupRequest"
      SET status = 'REJECTED', "rejectReason" = ${reason}, "updatedAt" = NOW()
      WHERE id = ${id}::uuid AND status = 'PENDING'
    `;

    if (result === 0) {
      throw new DomainException(409, 'CONFLICT', 'Topup request is not PENDING or already processed');
    }

    await prisma.topupAuditLog.create({
      data: {
        topupRequestId: id,
        actorId: adminId,
        action: 'REJECT',
        fromStatus: TopupStatus.PENDING,
        toStatus: TopupStatus.REJECTED,
        reason
      }
    });
  }
}
