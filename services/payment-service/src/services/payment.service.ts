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

    if (payment.status !== PaymentStatus.PENDING && payment.status !== PaymentStatus.PROCESSING) {
      throw new DomainException(409, 'CONFLICT', `Payment is in ${payment.status} status. Cannot confirm.`);
    }

    // 4. Kiểm tra TTL giữ tiền (nếu còn ở PENDING)
    if (payment.status === PaymentStatus.PENDING && payment.holdExpiresAt && payment.holdExpiresAt.getTime() < Date.now()) {
      if (payment.holdId) {
        await this.walletClient.releaseHold(payment.userId, payment.holdId);
      }
      const updated = await prisma.payment.update({
        where: { id },
        data: {
          status: PaymentStatus.EXPIRED,
          histories: {
            create: {
              id: randomUUID(),
              fromStatus: payment.status,
              toStatus: PaymentStatus.EXPIRED,
              note: 'Hold expired during confirm',
            }
          }
        }
      });
      await prisma.outboxEvent.create({
        data: {
          id: randomUUID(),
          aggregateId: id,
          eventType: 'PAYMENT_EXPIRED',
          topic: payment.callbackTopic,
          payload: JSON.parse(JSON.stringify(updated)),
          status: OutboxEventStatus.PENDING,
        }
      });
      throw new DomainException(410, 'PAYMENT_EXPIRED', 'Hold has expired, please checkout again');
    }

    // 5. PENDING -> PROCESSING và consume token chống replay
    if (payment.status === PaymentStatus.PENDING) {
      await prisma.$transaction(async (tx) => {
        try {
          await tx.usedTransactionToken.create({
            data: {
              jti: tokenPayload.jti,
              paymentId: payment.id,
              userId: tokenPayload.sub,
            }
          });
        } catch (err: any) {
          if (err.code === 'P2002') {
            throw new DomainException(409, 'TXN_TOKEN_REUSED', 'Transaction token has already been used');
          }
          throw err;
        }

        await tx.payment.update({
          where: { id },
          data: {
            status: PaymentStatus.PROCESSING,
            histories: {
              create: {
                id: randomUUID(),
                fromStatus: PaymentStatus.PENDING,
                toStatus: PaymentStatus.PROCESSING,
                note: 'Payment status changed to PROCESSING before capture',
              }
            }
          }
        });
      });
    } else {
      // payment.status === PaymentStatus.PROCESSING (retry confirm)
      try {
        await prisma.usedTransactionToken.create({
          data: {
            jti: tokenPayload.jti,
            paymentId: payment.id,
            userId: tokenPayload.sub,
          }
        });
      } catch (err: any) {
        if (err.code === 'P2002') {
          const used = await prisma.usedTransactionToken.findUnique({
            where: { jti: tokenPayload.jti }
          });
          if (!used || used.paymentId !== payment.id) {
            throw new DomainException(409, 'TXN_TOKEN_REUSED', 'Transaction token has already been used');
          }
        } else {
          throw err;
        }
      }
    }

    // 6. Gọi captureHold (lũy đẳng theo referenceId)
    try {
      await this.walletClient.captureHold(payment.userId, payment.holdId);

      // Capture thành công -> chuyển sang SUCCESS, ghi outbox event PAYMENT_SUCCESS
      return await prisma.$transaction(async (tx) => {
        const updated = await tx.payment.update({
          where: { id },
          data: {
            status: PaymentStatus.SUCCESS,
            histories: {
              create: {
                id: randomUUID(),
                fromStatus: PaymentStatus.PROCESSING,
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
    } catch (captureError: any) {
      if (captureError instanceof DomainException) {
        throw captureError;
      }
      console.error(`Confirm payment capture error for ${id}:`, captureError);

      // Nếu capture lỗi dứt khoát (Deterministic, e.g. 4xx từ wallet):
      // -> FAILED, release hold, hoàn usage, ghi sự kiện outbox PAYMENT_FAILED
      // Tuyệt đối không gọi credit (compensate) tạo tiền từ hư không (P0-4)!
      // Ánh xạ HOLD_EXPIRED hoặc HOLD_NOT_CAPTURABLE -> EXPIRED (410 PAYMENT_EXPIRED)
      const isHoldExpired =
        captureError.code === 'HOLD_EXPIRED' ||
        captureError.code === 'HOLD_NOT_CAPTURABLE' ||
        captureError.message?.includes('HOLD_EXPIRED') ||
        captureError.message?.includes('HOLD_NOT_CAPTURABLE') ||
        captureError.message?.includes('Hold has expired') ||
        captureError.message?.includes('Hold has already been released');

      if (isHoldExpired) {
        if (payment.holdId) {
          await this.walletClient.releaseHold(payment.userId, payment.holdId);
        }

        const expiredNote = captureError.message || 'Hold expired or not capturable';

        await prisma.$transaction(async (tx) => {
          const updated = await tx.payment.update({
            where: { id },
            data: {
              status: PaymentStatus.EXPIRED,
              failureReason: expiredNote,
              histories: {
                create: {
                  id: randomUUID(),
                  fromStatus: PaymentStatus.PROCESSING,
                  toStatus: PaymentStatus.EXPIRED,
                  note: expiredNote,
                }
              }
            }
          });

          await tx.outboxEvent.create({
            data: {
              id: randomUUID(),
              aggregateId: id,
              eventType: 'PAYMENT_EXPIRED',
              topic: payment.callbackTopic,
              payload: JSON.parse(JSON.stringify(updated)),
              status: OutboxEventStatus.PENDING,
            }
          });
        });

        throw new DomainException(410, 'PAYMENT_EXPIRED', captureError.message || 'Giao dịch thanh toán đã hết hạn');
      }

      if (captureError.isDeterministic) {
        if (payment.holdId) {
          await this.walletClient.releaseHold(payment.userId, payment.holdId);
        }

        const failureNote = captureError.message || 'Capture failed deterministically';

        await prisma.$transaction(async (tx) => {
          const updated = await tx.payment.update({
            where: { id },
            data: {
              status: PaymentStatus.FAILED,
              failureReason: failureNote,
              histories: {
                create: {
                  id: randomUUID(),
                  fromStatus: PaymentStatus.PROCESSING,
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
        });

        throw new DomainException(400, 'PAYMENT_FAILED', captureError.message || 'Thanh toán thất bại');
      }

      // Không chắc kết quả (timeout, network error, 5xx):
      // Giữ PROCESSING và cho phép thử lại capture (vì capture theo referenceId là lũy đẳng).
      await prisma.paymentHistory.create({
        data: {
          id: randomUUID(),
          paymentId: id,
          fromStatus: PaymentStatus.PROCESSING,
          toStatus: PaymentStatus.PROCESSING,
          note: `Capture timed out or network error: ${captureError.message}. Kept PROCESSING for retry.`,
        }
      }).catch((e: any) => console.error('Failed to log history for indeterminate error:', e));

      throw new DomainException(504, 'GATEWAY_TIMEOUT', 'Giao dịch đang được xử lý hoặc kết nối tới ví bị gián đoạn. Vui lòng thử lại sau.');
    }
  }

  async internalConfirm(id: string) {
    const payment = await prisma.payment.findUnique({ where: { id } });
    if (!payment) throw new DomainException(404, 'NOT_FOUND', 'Payment not found');

    if (payment.status === PaymentStatus.SUCCESS) {
      throw new DomainException(409, 'PAYMENT_ALREADY_CONFIRMED', 'Payment has already been confirmed');
    }

    if (payment.status !== PaymentStatus.PENDING && payment.status !== PaymentStatus.PROCESSING) {
      throw new DomainException(409, 'CONFLICT', `Payment is in ${payment.status} status. Cannot confirm.`);
    }

    if (payment.status === PaymentStatus.PENDING && payment.holdExpiresAt && payment.holdExpiresAt.getTime() < Date.now()) {
      if (payment.holdId) {
        await this.walletClient.releaseHold(payment.userId, payment.holdId);
      }
      const updated = await prisma.payment.update({
        where: { id },
        data: {
          status: PaymentStatus.EXPIRED,
          histories: {
            create: {
              id: randomUUID(),
              fromStatus: payment.status,
              toStatus: PaymentStatus.EXPIRED,
              note: 'Hold expired during internal confirm',
            }
          }
        }
      });
      await prisma.outboxEvent.create({
        data: {
          id: randomUUID(),
          aggregateId: id,
          eventType: 'PAYMENT_EXPIRED',
          topic: payment.callbackTopic,
          payload: JSON.parse(JSON.stringify(updated)),
          status: OutboxEventStatus.PENDING,
        }
      });
      throw new DomainException(410, 'PAYMENT_EXPIRED', 'Hold has expired, please checkout again');
    }

    if (payment.status === PaymentStatus.PENDING) {
      await prisma.payment.update({
        where: { id },
        data: {
          status: PaymentStatus.PROCESSING,
          histories: {
            create: {
              id: randomUUID(),
              fromStatus: PaymentStatus.PENDING,
              toStatus: PaymentStatus.PROCESSING,
              note: 'Internal payment status changed to PROCESSING before capture',
            }
          }
        }
      });
    }

    try {
      await this.walletClient.captureHold(payment.userId, payment.holdId);

      return await prisma.$transaction(async (tx) => {
        const updated = await tx.payment.update({
          where: { id },
          data: {
            status: PaymentStatus.SUCCESS,
            histories: {
              create: {
                id: randomUUID(),
                fromStatus: PaymentStatus.PROCESSING,
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
    } catch (captureError: any) {
      if (captureError instanceof DomainException) throw captureError;
      console.error(`Internal confirm payment capture error for ${id}:`, captureError);

      const isHoldExpired =
        captureError.code === 'HOLD_EXPIRED' ||
        captureError.code === 'HOLD_NOT_CAPTURABLE' ||
        captureError.message?.includes('HOLD_EXPIRED') ||
        captureError.message?.includes('HOLD_NOT_CAPTURABLE') ||
        captureError.message?.includes('Hold has expired') ||
        captureError.message?.includes('Hold has already been released');

      if (isHoldExpired) {
        if (payment.holdId) {
          await this.walletClient.releaseHold(payment.userId, payment.holdId);
        }

        const expiredNote = captureError.message || 'Hold expired or not capturable';

        await prisma.$transaction(async (tx) => {
          const updated = await tx.payment.update({
            where: { id },
            data: {
              status: PaymentStatus.EXPIRED,
              failureReason: expiredNote,
              histories: {
                create: {
                  id: randomUUID(),
                  fromStatus: PaymentStatus.PROCESSING,
                  toStatus: PaymentStatus.EXPIRED,
                  note: expiredNote,
                }
              }
            }
          });

          await tx.outboxEvent.create({
            data: {
              id: randomUUID(),
              aggregateId: id,
              eventType: 'PAYMENT_EXPIRED',
              topic: payment.callbackTopic,
              payload: JSON.parse(JSON.stringify(updated)),
              status: OutboxEventStatus.PENDING,
            }
          });
        });

        throw new DomainException(410, 'PAYMENT_EXPIRED', captureError.message || 'Giao dịch thanh toán đã hết hạn');
      }

      if (captureError.isDeterministic) {
        if (payment.holdId) {
          await this.walletClient.releaseHold(payment.userId, payment.holdId);
        }

        const failureNote = captureError.message || 'Internal capture failed deterministically';

        await prisma.$transaction(async (tx) => {
          const updated = await tx.payment.update({
            where: { id },
            data: {
              status: PaymentStatus.FAILED,
              failureReason: failureNote,
              histories: {
                create: {
                  id: randomUUID(),
                  fromStatus: PaymentStatus.PROCESSING,
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
        });

        throw new DomainException(400, 'PAYMENT_FAILED', captureError.message || 'Thanh toán nội bộ thất bại');
      }

      await prisma.paymentHistory.create({
        data: {
          id: randomUUID(),
          paymentId: id,
          fromStatus: PaymentStatus.PROCESSING,
          toStatus: PaymentStatus.PROCESSING,
          note: `Internal capture timed out or indeterminate network error: ${captureError.message}. Kept PROCESSING for retry.`,
        }
      }).catch((e: any) => console.error('Failed to log history for indeterminate internal error:', e));

      throw new DomainException(504, 'GATEWAY_TIMEOUT', 'Giao dịch đang được xử lý hoặc kết nối tới ví bị gián đoạn. Vui lòng thử lại sau.');
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

  // Thêm yêu cầu api phải chính là người dùng gọi hoặc là tài khoản admin
  // Tránh hiện một người khác có mã paymentId có thể hủy.
  async cancel(id: string, requesterId: string, requesterRole?: string) {
    const payment = await prisma.payment.findUnique({ where: { id } });
    if (!payment) throw new DomainException(404, 'NOT_FOUND', 'Payment not found');
    if (requesterRole !== 'ADMIN' && payment.userId !== requesterId) {
      throw new DomainException(403, 'FORBIDDEN', 'Payment belongs to another user');
    }
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
            note: requesterRole === 'ADMIN' && payment.userId !== requesterId ? 'Admin cancelled and hold released' : 'User cancelled and hold released',
          }
        }
      }
    });
  }

  // Chỉ người dùng hoặc admin mới được quyền gọi
  async getById(id: string, requesterId: string, requesterRole?: string) {
    const payment = await prisma.payment.findUnique({
      where: { id },
      include: { histories: true }
    });
    if (!payment) throw new DomainException(404, 'NOT_FOUND', 'Payment not found');
    if (requesterRole !== 'ADMIN' && payment.userId !== requesterId) {
      throw new DomainException(403, 'FORBIDDEN', 'Payment belongs to another user');
    }
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

