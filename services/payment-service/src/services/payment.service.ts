import { DomainException } from '../utils/domain.exception';
import { PaymentStatus, OutboxEventStatus, PaymentType } from '../utils/enums';
import { IdempotencyStatus } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { randomUUID } from 'crypto';
import * as crypto from 'crypto';
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

  async checkout(dto: CheckoutDto) {
    const hashData = `${dto.amount}|${dto.type}|${dto.referenceId || ''}|${dto.callbackTopic}`;
    const requestHash = crypto.createHash('sha256').update(hashData).digest('hex');
    
    const paymentId = randomUUID();
    const holdId = randomUUID();
    const holdExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 phút
    const idempotencyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 giờ

    let payment: any;

    // 1. Thử tranh khóa (Acquire Lock) bằng cách CREATE thẳng
    try {
      payment = await prisma.payment.create({
        data: {
          id: paymentId,
          userId: dto.userId,
          amount: dto.amount,
          type: dto.type,
          referenceId: dto.referenceId || '',
          callbackTopic: dto.callbackTopic,
          idempotencyKey: dto.idempotencyKey,
          requestHash,
          idempotencyStatus: IdempotencyStatus.PROCESSING,
          idempotencyExpiresAt,
          status: PaymentStatus.PENDING,
          holdId: holdId,
          holdExpiresAt: holdExpiresAt,
          histories: {
            create: {
              id: randomUUID(),
              toStatus: PaymentStatus.PENDING,
              note: 'Payment checkout created in PROCESSING state',
            }
          }
        }
      });
    } catch (err: any) {
      if (err.code === 'P2002') { // Lỗi Unique Constraint (Idempotency Key đã tồn tại)
        const existing = await prisma.payment.findUnique({
          where: { userId_idempotencyKey: { userId: dto.userId, idempotencyKey: dto.idempotencyKey } }
        });
        
        if (!existing) throw new DomainException(500, 'INTERNAL_ERROR', 'Idempotency conflict but record missing');
        
        // Kiểm tra tính toàn vẹn Payload
        if (existing.requestHash !== requestHash && existing.requestHash !== 'LEGACY') {
          throw new DomainException(422, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'Idempotency key reused with different payload');
        }

        // Xử lý State Machine
        if (existing.idempotencyStatus === IdempotencyStatus.PROCESSING) {
          throw new DomainException(409, 'IDEMPOTENCY_REQUEST_IN_PROGRESS', 'Request in progress. Please retry later.');
        }

        if (existing.idempotencyStatus === IdempotencyStatus.COMPLETED) {
          return { payment: existing, replayed: true };
        }

        if (existing.idempotencyStatus === IdempotencyStatus.FAILED) {
          // Retry an toàn
          const updateRes = await prisma.payment.updateMany({
            where: { id: existing.id, idempotencyStatus: IdempotencyStatus.FAILED },
            data: { 
              idempotencyStatus: IdempotencyStatus.PROCESSING, 
              requestHash, 
              holdId, 
              holdExpiresAt,
              idempotencyExpiresAt 
            }
          });
          if (updateRes.count === 0) {
            throw new DomainException(409, 'IDEMPOTENCY_REQUEST_IN_PROGRESS', 'Request in progress by another thread.');
          }
          payment = { ...existing, idempotencyStatus: IdempotencyStatus.PROCESSING, holdId, holdExpiresAt };
        }
      } else {
        throw err;
      }
    }

    // 2. Chạy nghiệp vụ Side-effect (Call sang Wallet Service)
    let holdSucceeded = false;
    try {
      await this.walletClient.createHold(dto.userId, dto.amount.toString(), payment.holdId!, payment.holdExpiresAt!.toISOString());
      holdSucceeded = true;
    } catch (err: any) {
      // Nếu hold xịt, nhả khóa về FAILED cho phép retry
      await prisma.payment.update({
        where: { id: payment.id! },
        data: { 
          idempotencyStatus: IdempotencyStatus.FAILED, 
          status: PaymentStatus.FAILED, 
          failureReason: 'Hold failed: ' + (err.message || 'Unknown')
        }
      });
      if (err instanceof DomainException) throw err;
      throw new DomainException(500, 'INTERNAL_ERROR', 'Failed to communicate with wallet service for hold');
    }

    // 3. Hoàn tất Idempotency Lock
    const finalizedPayment = await prisma.payment.update({
      where: { id: payment.id! },
      data: { idempotencyStatus: IdempotencyStatus.COMPLETED }
    });

    return { payment: finalizedPayment, replayed: false };
  }

  async confirm(id: string) {
    const payment = await prisma.payment.findUnique({ where: { id } });
    if (!payment) throw new DomainException(404, 'NOT_FOUND', 'Payment not found');
    if (payment.status !== PaymentStatus.PENDING) {
      throw new DomainException(409, 'CONFLICT', `Payment is in ${payment.status} status. Cannot confirm.`);
    }

    if (payment.holdExpiresAt && payment.holdExpiresAt.getTime() < Date.now()) {
      await this.walletClient.releaseHold(payment.userId, payment.holdId!);
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
      await this.walletClient.captureHold(payment.userId, payment.holdId!);

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
        await this.walletClient.credit(payment.userId, payment.amount.toString(), `compensate_${payment.id}`);
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

  async cancel(id: string) {
    const payment = await prisma.payment.findUnique({ where: { id } });
    if (!payment) throw new DomainException(404, 'NOT_FOUND', 'Payment not found');
    if (payment.status !== PaymentStatus.PENDING) {
      throw new DomainException(409, 'CONFLICT', `Payment is in ${payment.status} status. Cannot cancel.`);
    }

    if (payment.holdId) {
      await this.walletClient.releaseHold(payment.userId, payment.holdId);
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
}
