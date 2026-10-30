import { P2pService } from './p2p.service';
import { DomainException } from '../utils/domain.exception';
import { PaymentStatus, OutboxEventStatus, PaymentType } from '../utils/enums';
import { prisma } from '../utils/prisma';
import { randomUUID } from 'crypto';
import { WalletClient } from '../clients/wallet.client';

export interface CheckoutDto {
  userId: string;
  amount: number;
  type: PaymentType;
  referenceId?: string;
  callbackTopic: string;
  idempotencyKey: string;
}

export class PaymentService {
  constructor(private walletClient: WalletClient) {}

  async checkout(dto: CheckoutDto & { destinationUserId: string }) {
    return new P2pService(this.walletClient).checkout(dto);
  }
  async confirm(id: string, userId: string, token: string) {
    return new P2pService(this.walletClient).confirm(id, userId, token);
  }

  async refund(id: string) {
    return await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id } });
      if (!payment) throw new DomainException(404, 'NOT_FOUND', 'Payment not found');
      if (payment.destinationUserId) throw new DomainException(409, 'P2P_REFUND_UNSUPPORTED', 'P2P refunds require a reverse transfer');
      if (payment.status !== PaymentStatus.SUCCESS) {
        throw new DomainException(409, 'CONFLICT', `Payment is in ${payment.status} status. Cannot refund.`);
      }

      try {
        await this.walletClient.refundCredit(payment.userId, payment.amount.toString(), `refund_${payment.id}`);

        const updated = await tx.payment.update({
          where: { id },
          data: {
            status: PaymentStatus.REFUNDED,
            histories: {
              create: {
                id: randomUUID(),
                fromStatus: PaymentStatus.SUCCESS,
                toStatus: PaymentStatus.REFUNDED,
                note: 'Refund successful',
              }
            }
          }
        });

        await tx.outboxEvent.create({
          data: {
            id: randomUUID(),
            aggregateId: id,
            eventType: 'PAYMENT_REFUNDED',
            topic: payment.callbackTopic,
            payload: JSON.parse(JSON.stringify(updated)),
            status: OutboxEventStatus.PENDING,
          }
        });

        return updated;
      } catch (error: any) {
        console.error(`Refund payment failed for ${id}:`, error);
        throw new DomainException(500, 'INTERNAL_ERROR', 'Refund failed');
      }
    });
  }

  async cancel(id: string, requesterId: string) {
    return new P2pService(this.walletClient).cancel(id, requesterId);
  }

  async getById(id: string, requesterId: string) {
    const payment = await prisma.payment.findUnique({
      where: { id },
      include: { histories: true }
    });
    if (payment && payment.userId !== requesterId) throw new DomainException(403, 'FORBIDDEN', 'Payment belongs to another user');
    return payment;
  }

  async list(userId?: string, type?: string, status?: string) {
    return await prisma.payment.findMany({
      where: {
        ...(userId && { userId }),
        ...(type && { type: type as PaymentType }),
        ...(status && { status: status as PaymentStatus }),
      },
      orderBy: { createdAt: 'desc' }
    });
  }
}
