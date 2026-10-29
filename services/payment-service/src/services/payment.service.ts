import { DomainException } from '../utils/domain.exception';
import { PaymentStatus, OutboxEventStatus, PaymentType } from '../utils/enums';
import { IdempotencyStatus, Prisma } from '@prisma/client';
import { TransactionTokenPayload } from '../middlewares/transactionToken';
import { prisma } from '../utils/prisma';
import { randomUUID } from 'crypto';
import * as crypto from 'crypto';
import { WalletClient } from '../clients/wallet.client';

export interface CheckoutDto {
  userId: string;
  amount: number | string;
  type: PaymentType;
  referenceId?: string;
  destinationUserId?: string;
  destinationOwnerType?: string;
  callbackTopic: string;
  idempotencyKey: string;
}

export class PaymentService {
  constructor(private walletClient: WalletClient) { }

  async checkout(dto: CheckoutDto) {
    const destUserId = dto.destinationUserId || (dto.type === PaymentType.WALLET_TRANSFER ? dto.referenceId : undefined);
    const destOwnerType = dto.destinationOwnerType || (destUserId ? 'USER' : undefined);

    // Kiểm tra nghiệp vụ người nhận: khác người gửi, tồn tại, ví ACTIVE
    if (destUserId) {
      if (destUserId === dto.userId) {
        throw new DomainException(400, 'SELF_TRANSFER_NOT_ALLOWED', 'Không thể chuyển tiền cho chính mình');
      }
      const destWallet = await this.walletClient.getBalance(destUserId);
      if (!destWallet) {
        throw new DomainException(404, 'DESTINATION_WALLET_NOT_FOUND', 'Người nhận không tồn tại hoặc chưa kích hoạt ví');
      }
      if (destWallet.status !== 'ACTIVE') {
        throw new DomainException(400, 'DESTINATION_WALLET_NOT_ACTIVE', 'Ví người nhận không ở trạng thái hoạt động');
      }
    }

    const hashData = `${dto.amount}|${dto.type}|${dto.referenceId || ''}|${destUserId || ''}|${dto.callbackTopic}`;
    const requestHash = crypto.createHash('sha256').update(hashData).digest('hex');

    const paymentId = randomUUID();
    const holdId = randomUUID();
    const holdExpiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 phút (theo yêu cầu P0-3)
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
          destinationUserId: destUserId || null,
          destinationOwnerType: destOwnerType || null,
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
      const destinationUserId = payment.destinationUserId || (dto.type === PaymentType.WALLET_TRANSFER ? dto.referenceId : undefined);
      const destinationOwnerType = payment.destinationOwnerType || (destinationUserId ? 'USER' : undefined);
      await this.walletClient.createHold(dto.userId, dto.amount.toString(), payment.holdId!, payment.holdExpiresAt!.toISOString(), destinationUserId, destinationOwnerType);
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

  async confirm(id: string, requesterUserId: string, tokenPayload: TransactionTokenPayload) {
    const payment = await prisma.payment.findUnique({ where: { id } });
    if (!payment) throw new DomainException(404, 'NOT_FOUND', 'Payment not found');

    // 1. Kiểm tra quyền sở hữu (ownership)
    if (payment.userId !== requesterUserId || tokenPayload.sub !== requesterUserId) {
      throw new DomainException(403, 'FORBIDDEN', 'Bạn không có quyền xác nhận thanh toán này');
    }

    // 2. Kiểm tra claims gắn chặt với paymentId và amount
    if (tokenPayload.paymentId !== payment.id) {
      throw new DomainException(403, 'FORBIDDEN', 'Transaction token does not match payment ID');
    }

    const tokenAmount = new Prisma.Decimal(tokenPayload.amount);
    if (!tokenAmount.equals(payment.amount)) {
      throw new DomainException(403, 'FORBIDDEN', 'Transaction token amount does not match payment amount');
    }

    // 3. Kiểm tra trạng thái Payment
    if (payment.status === PaymentStatus.SUCCESS) {
      throw new DomainException(409, 'PAYMENT_ALREADY_CONFIRMED', 'Payment has already been confirmed');
    }

    if (payment.status !== PaymentStatus.PENDING) {
      throw new DomainException(409, 'CONFLICT', `Payment is in ${payment.status} status. Cannot confirm.`);
    }

    // 4. Kiểm tra TTL giữ tiền
    if (payment.holdExpiresAt && payment.holdExpiresAt.getTime() < Date.now()) {
      if (payment.holdId) {
        await this.walletClient.releaseHold(payment.userId, payment.holdId);
      }
      await prisma.payment.update({
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
      return await prisma.$transaction(async (tx) => {
        // Atomic consume token: Chống Replay Attack bằng unique violation (P2002)
        try {
          await tx.usedTransactionToken.create({
            data: {
              jti: tokenPayload.jti,
              paymentId: payment.id,
              userId: tokenPayload.sub,
            }
          });
        } catch (err) {
          if (err.code === 'P2002') {
            throw new DomainException(409, 'TXN_TOKEN_REUSED', 'Transaction token has already been used');
          }
          throw err;
        }

        await this.walletClient.captureHold(payment.userId, payment.holdId);
        captureSucceeded = true;

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
      }, { maxWait: 15000, timeout: 25000 });
    } catch (error) {
      if (error instanceof DomainException) {
        throw error;
      }
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

  async internalConfirm(id: string) {
    const payment = await prisma.payment.findUnique({ where: { id } });
    if (!payment) throw new DomainException(404, 'NOT_FOUND', 'Payment not found');

    if (payment.status === PaymentStatus.SUCCESS) {
      throw new DomainException(409, 'PAYMENT_ALREADY_CONFIRMED', 'Payment has already been confirmed');
    }

    if (payment.status !== PaymentStatus.PENDING) {
      throw new DomainException(409, 'CONFLICT', `Payment is in ${payment.status} status. Cannot confirm.`);
    }

    if (payment.holdExpiresAt && payment.holdExpiresAt.getTime() < Date.now()) {
      if (payment.holdId) {
        await this.walletClient.releaseHold(payment.userId, payment.holdId);
      }
      await prisma.payment.update({
        where: { id },
        data: {
          status: PaymentStatus.EXPIRED,
          histories: {
            create: {
              id: randomUUID(),
              fromStatus: PaymentStatus.PENDING,
              toStatus: PaymentStatus.EXPIRED,
              note: 'Hold expired during internal confirm',
            }
          }
        }
      });
      throw new DomainException(400, 'EXPIRED', 'Hold has expired, please checkout again');
    }

    let captureSucceeded = false;
    try {
      await this.walletClient.captureHold(payment.userId, payment.holdId);
      captureSucceeded = true;

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
                note: 'Internal wallet capture successful',
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
    } catch (error) {
      if (error instanceof DomainException) throw error;
      console.error(`Internal confirm payment failed for ${id}:`, error);

      if (captureSucceeded) {
        await this.walletClient.credit(payment.userId, payment.amount.toString(), `compensate_${payment.id}`);
      }

      const failureNote = captureSucceeded
        ? `Compensating Transaction: Wallet capture succeeded but DB update failed. Lỗi gốc: ${error.message}`
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

  async cancel(id: string, requesterId: string) {
    const payment = await prisma.payment.findUnique({ where: { id } });
    if (!payment) throw new DomainException(404, 'NOT_FOUND', 'Payment not found');
    if (payment.userId !== requesterId) throw new DomainException(403, 'FORBIDDEN', 'Payment belongs to another user');
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

  // Luồng chuyển tiền p2p thông qua payment service để quản lý transaction
  // Luồng này sẽ tạo payment với status PENDING và hold số tiền tương ứng
  // Sau đó user sẽ confirm payment để hoàn tất transaction
  // Hoặc user có thể cancel payment để hoàn tác transaction
  // ** Luồng này dùng cho người dùng cuối user 
  async p2pQuote(senderId: string, destinationUserId: string, amountStr: string) {
    if (senderId === destinationUserId) {
      throw new DomainException(400, 'SELF_TRANSFER_NOT_ALLOWED', 'Không thể chuyển tiền cho chính mình');
    }

    const amountNum = Number(amountStr);
    if (isNaN(amountNum) || amountNum <= 0) {
      throw new DomainException(400, 'INVALID_AMOUNT', 'Số tiền không hợp lệ');
    }

    // 1. Kiểm tra ví người nhận có tồn tại không
    const destWallet = await this.walletClient.getBalance(destinationUserId);
    if (!destWallet) {
      throw new DomainException(404, 'DESTINATION_WALLET_NOT_FOUND', 'Người nhận không tồn tại hoặc chưa kích hoạt ví');
    }

    // 2. Kiểm tra số dư khả dụng của người gửi
    const senderWallet = await this.walletClient.getBalance(senderId);
    if (!senderWallet) {
      throw new DomainException(404, 'SENDER_WALLET_NOT_FOUND', 'Ví người gửi không tồn tại');
    }

    const availableBalance = Number(senderWallet.availableBalance ?? senderWallet.balance);
    if (availableBalance < amountNum) {
      throw new DomainException(400, 'INSUFFICIENT_FUNDS', 'Số dư khả dụng không đủ để thực hiện giao dịch');
    }

    // 3. TTL 60 giây
    const expiresAt = new Date(Date.now() + 60 * 1000).toISOString();

    return {
      destinationUserId,
      amount: amountStr,
      fee: 0,
      expiresAt
    };
  }

  // Luồng chuyển tiền P2P checkout chuẩn hóa
  async p2pCheckout(dto: {
    senderId: string;
    destinationUserId: string;
    destinationOwnerType?: string;
    amount: string;
    idempotencyKey: string;
    note?: string;
  }) {
    const amountNum = Number(dto.amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      throw new DomainException(400, 'INVALID_AMOUNT', 'Số tiền không hợp lệ');
    }

    return await this.checkout({
      userId: dto.senderId,
      amount: dto.amount,
      type: PaymentType.WALLET_TRANSFER,
      referenceId: dto.destinationUserId,
      destinationUserId: dto.destinationUserId,
      destinationOwnerType: dto.destinationOwnerType || 'USER',
      callbackTopic: 'payment.p2p.events',
      idempotencyKey: dto.idempotencyKey,
    });
  }
}

