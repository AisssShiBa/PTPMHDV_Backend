import { DomainException } from '../utils/domain.exception';
import { PaymentStatus, OutboxEventStatus, PaymentType } from '../utils/enums';
import { prisma } from '../utils/prisma';
import { randomUUID } from 'crypto';

export interface CheckoutDto {
  userId: string;
  amount: number;
  type: PaymentType;
  referenceId?: string;
  callbackTopic: string;
  idempotencyKey: string;
}

export class PaymentService {
  async checkout(dto: CheckoutDto) {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.payment.findUnique({
        where: { idempotencyKey: dto.idempotencyKey }
      });
      if (existing) {
        console.log(`Idempotency key ${dto.idempotencyKey} already exists. Returning existing payment.`);
        return { payment: existing, replayed: true };
      }

      const payment = await tx.payment.create({
        data: {
          id: randomUUID(),
          userId: dto.userId,
          amount: dto.amount,
          type: dto.type,
          referenceId: dto.referenceId || '',
          callbackTopic: dto.callbackTopic,
          idempotencyKey: dto.idempotencyKey,
          status: PaymentStatus.PENDING,
          histories: {
            create: {
              id: randomUUID(),
              toStatus: PaymentStatus.PENDING,
              note: 'Payment checkout created',
            }
          }
        }
      });
      return { payment, replayed: false };
    });
  }

  async confirm(id: string) {
    return await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id } });
      if (!payment) throw new DomainException(404, 'NOT_FOUND', 'Payment not found');
      if (payment.status !== PaymentStatus.PENDING) {
        throw new DomainException(409, 'CONFLICT', `Payment is in ${payment.status} status. Cannot confirm.`);
      }

      try {
        // Call Wallet Service Debit
        const response = await fetch(`${process.env.WALLET_SERVICE_URL}/api/wallets/${payment.userId}/debit`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-key': process.env.INTERNAL_KEY || 'default_internal_secret_key_123456'
          },
          body: JSON.stringify({
            amount: payment.amount.toString(),
            referenceId: payment.id
          })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.message || 'Debit failed');
        }

        const updated = await tx.payment.update({
          where: { id },
          data: {
            status: PaymentStatus.SUCCESS,
            histories: {
              create: {
                id: randomUUID(),
                fromStatus: PaymentStatus.PENDING,
                toStatus: PaymentStatus.SUCCESS,
                note: 'Wallet debit successful',
              }
            }
          }
        });

        await tx.outboxEvent.create({
          data: {
            id: randomUUID(),
            aggregateId: id,
            eventType: 'PAYMENT_SUCCESS',
            topic: payment.callbackTopic,
            payload: JSON.parse(JSON.stringify(updated)),
            status: OutboxEventStatus.PENDING,
          }
        });

        return updated;
      } catch (error: any) {
        console.error(`Confirm payment failed for ${id}:`, error);

        const updated = await tx.payment.update({
          where: { id },
          data: {
            status: PaymentStatus.FAILED,
            failureReason: error.message,
            histories: {
              create: {
                id: randomUUID(),
                fromStatus: PaymentStatus.PENDING,
                toStatus: PaymentStatus.FAILED,
                note: error.message,
              }
            }
          }
        });

        await tx.outboxEvent.create({
          data: {
            id: randomUUID(),
            aggregateId: id,
            eventType: 'PAYMENT_FAILED',
            topic: payment.callbackTopic,
            payload: JSON.parse(JSON.stringify(updated)),
            status: OutboxEventStatus.PENDING,
          }
        });

        return updated;
      }
    });
  }

  async refund(id: string) {
    return await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id } });
      if (!payment) throw new DomainException(404, 'NOT_FOUND', 'Payment not found');
      if (payment.status !== PaymentStatus.SUCCESS) {
        throw new DomainException(409, 'CONFLICT', `Payment is in ${payment.status} status. Cannot refund.`);
      }

      try {
        const response = await fetch(`${process.env.WALLET_SERVICE_URL}/api/wallets/${payment.userId}/credit`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-key': process.env.INTERNAL_KEY || 'default_internal_secret_key_123456'
          },
          body: JSON.stringify({
            amount: payment.amount.toString(),
            referenceId: `refund_${payment.id}`
          })
        });

        if (!response.ok) {
          throw new Error('Credit failed');
        }

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

  async cancel(id: string) {
    return await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id } });
      if (!payment) throw new DomainException(404, 'NOT_FOUND', 'Payment not found');
      if (payment.status !== PaymentStatus.PENDING) {
        throw new DomainException(409, 'CONFLICT', `Payment is in ${payment.status} status. Cannot cancel.`);
      }

      return await tx.payment.update({
        where: { id },
        data: {
          status: PaymentStatus.CANCELLED,
          histories: {
            create: {
              id: randomUUID(),
              fromStatus: PaymentStatus.PENDING,
              toStatus: PaymentStatus.CANCELLED,
              note: 'User cancelled',
            }
          }
        }
      });
    });
  }

  async getById(id: string) {
    return await prisma.payment.findUnique({
      where: { id },
      include: { histories: true }
    });
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
