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
    const existing = await prisma.payment.findUnique({
      where: { idempotencyKey: dto.idempotencyKey }
    });
    if (existing) {
      console.log(`Idempotency key ${dto.idempotencyKey} already exists. Returning existing payment.`);
      return { payment: existing, replayed: true };
    }

    const holdId = randomUUID();
    const holdExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    let holdSucceeded = false;

    // 1. Call Wallet hold
    try {
      const response = await fetch(`${process.env.WALLET_SERVICE_URL}/api/wallets/${dto.userId}/hold`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-key': process.env.INTERNAL_KEY || 'default_internal_secret_key_123456'
        },
        body: JSON.stringify({
          amount: dto.amount.toString(),
          referenceId: holdId,
          expiresAt: holdExpiresAt.toISOString()
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new DomainException(400, 'HOLD_FAILED', errorData.message || 'Failed to hold amount in wallet');
      }

      holdSucceeded = true;
    } catch (err: any) {
      console.error(`Hold failed for user ${dto.userId}:`, err);
      if (err instanceof DomainException) throw err;
      throw new DomainException(500, 'INTERNAL_ERROR', 'Failed to communicate with wallet service for hold');
    }

    // 2. Create Payment
    try {
      return await prisma.$transaction(async (tx) => {
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
            holdId: holdId,
            holdExpiresAt: holdExpiresAt,
            histories: {
              create: {
                id: randomUUID(),
                toStatus: PaymentStatus.PENDING,
                note: 'Payment checkout created and amount held',
              }
            }
          }
        });
        return { payment, replayed: false };
      });
    } catch (error: any) {
      console.error(`Checkout DB save failed for idempotencyKey ${dto.idempotencyKey}:`, error);

      if (holdSucceeded) {
        console.log(`[Saga Compensate] DB save failed. Calling release to free up user's money...`);
        await this.releaseWalletHold(dto.userId, holdId);
      }

      throw new DomainException(500, 'INTERNAL_ERROR', 'Database error during checkout. Wallet hold has been released.');
    }
  }

  async confirm(id: string) {
    const payment = await prisma.payment.findUnique({ where: { id } });
    if (!payment) throw new DomainException(404, 'NOT_FOUND', 'Payment not found');
    if (payment.status !== PaymentStatus.PENDING) {
      throw new DomainException(409, 'CONFLICT', `Payment is in ${payment.status} status. Cannot confirm.`);
    }

    if (payment.holdExpiresAt && payment.holdExpiresAt.getTime() < Date.now()) {
      await this.releaseWalletHold(payment.userId, payment.holdId!);
      const updated = await prisma.payment.update({
        where: { id },
        data: {
          status: PaymentStatus.EXPIRED,
          histories: {
            create: {
              id: randomUUID(),
              fromStatus: PaymentStatus.PENDING,
              toStatus: PaymentStatus.EXPIRED,
              note: 'Hold expired during confirm',
            }
          }
        }
      });
      throw new DomainException(400, 'EXPIRED', 'Hold has expired, please checkout again');
    }

    let captureSucceeded = false;

    try {
      const response = await fetch(`${process.env.WALLET_SERVICE_URL}/api/wallets/${payment.userId}/capture`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-key': process.env.INTERNAL_KEY || 'default_internal_secret_key_123456'
        },
        body: JSON.stringify({
          referenceId: payment.holdId
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || 'Capture failed');
      }

      captureSucceeded = true;
      console.log(`[Saga] Wallet capture success for payment ${id}`);

      // ⚠️ Giả lập lỗi timeout/crash SAU KHI wallet đã capture thành công nếu test
      // throw new Error('[TEST] Simulated error after successful wallet capture');

      return await prisma.$transaction(async (tx) => {
        const updated = await tx.payment.update({
          where: { id },
          data: {
            status: PaymentStatus.SUCCESS,
            histories: {
              create: {
                id: randomUUID(),
                fromStatus: PaymentStatus.PENDING,
                toStatus: PaymentStatus.SUCCESS,
                note: 'Wallet capture successful',
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
      });
    } catch (error: any) {
      console.error(`Confirm payment failed for ${id}:`, error);

      if (captureSucceeded) {
        console.log(`[Saga Compensate] Capture success but DB failed. Calling credit to refund...`);
        await this.creditWallet(payment.userId, payment.amount.toString(), `compensate_${payment.id}`);
      }

      const failureNote = captureSucceeded
        ? `Compensating Transaction: Wallet capture succeeded but DB update failed. Credit called. Lỗi gốc: ${error.message}`
        : error.message;

      return await prisma.$transaction(async (tx) => {
        const updated = await tx.payment.update({
          where: { id },
          data: {
            status: PaymentStatus.FAILED,
            failureReason: failureNote,
            histories: {
              create: {
                id: randomUUID(),
                fromStatus: PaymentStatus.PENDING,
                toStatus: PaymentStatus.FAILED,
                note: failureNote,
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
      });
    }
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
    const payment = await prisma.payment.findUnique({ where: { id } });
    if (!payment) throw new DomainException(404, 'NOT_FOUND', 'Payment not found');
    if (payment.status !== PaymentStatus.PENDING) {
      throw new DomainException(409, 'CONFLICT', `Payment is in ${payment.status} status. Cannot cancel.`);
    }

    if (payment.holdId) {
      await this.releaseWalletHold(payment.userId, payment.holdId);
    }

    return await prisma.payment.update({
      where: { id },
      data: {
        status: PaymentStatus.CANCELLED,
        histories: {
          create: {
            id: randomUUID(),
            fromStatus: PaymentStatus.PENDING,
            toStatus: PaymentStatus.CANCELLED,
            note: 'User cancelled and hold released',
          }
        }
      }
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

  private async releaseWalletHold(userId: string, holdId: string) {
    try {
      const response = await fetch(`${process.env.WALLET_SERVICE_URL}/api/wallets/${userId}/release`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-key': process.env.INTERNAL_KEY || 'default_internal_secret_key_123456'
        },
        body: JSON.stringify({
          referenceId: holdId
        })
      });

      if (!response.ok) {
        console.error(`[Wallet Release] Failed to release hold ${holdId} for user ${userId}. Wallet returned non-OK.`);
      } else {
        console.log(`[Wallet Release] Successfully released hold ${holdId} for user ${userId}.`);
      }
    } catch (error: any) {
      console.error(`[Wallet Release] Network/System Error releasing hold ${holdId} for user ${userId}:`, error.message);
    }
  }

  private async creditWallet(userId: string, amount: string, referenceId: string) {
    try {
      const response = await fetch(`${process.env.WALLET_SERVICE_URL}/api/wallets/${userId}/credit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-key': process.env.INTERNAL_KEY || 'default_internal_secret_key_123456'
        },
        body: JSON.stringify({
          amount,
          referenceId
        })
      });

      if (!response.ok) {
        console.error(`[Wallet Credit] Failed to refund (compensate) ${amount} for user ${userId}. Wallet returned non-OK.`);
      } else {
        console.log(`[Wallet Credit] Successfully refunded (compensated) ${amount} for user ${userId}.`);
      }
    } catch (error: any) {
      console.error(`[Wallet Credit] Network/System Error refunding user ${userId}:`, error.message);
    }
  }
}
