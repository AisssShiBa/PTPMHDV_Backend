import { createHash, randomUUID } from 'node:crypto';
import { Payment, Prisma, PaymentStatus } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { DomainException } from '../utils/domain.exception';
import { verifyPaymentToken } from '../utils/transaction-token';
import { WalletClient } from '../clients/wallet.client';
import type { TransactionTokenPayload } from '../middlewares/transactionToken';
import { drainOutbox } from '../jobs/outbox.job';

type Checkout = { userId: string; destinationUserId: string; amount: string | number;
  destinationOwnerType?: string; type: any; referenceId?: string; callbackTopic?: string; idempotencyKey: string };
const transactionOptions = { maxWait: 15000, timeout: 25000 };
async function locked(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM "Payment" WHERE id=${id}::uuid FOR UPDATE`;
  const payment = await tx.payment.findUnique({ where: { id } });
  if (!payment) throw new DomainException(404, 'NOT_FOUND', 'Payment not found');
  return payment;
}
async function finish(tx: Prisma.TransactionClient, payment: Payment, status: PaymentStatus, reason?: string) {
  const updated = await tx.payment.update({ where: { id: payment.id }, data: {
    status, workflow: 'IDLE', failureReason: reason,
    histories: { create: { fromStatus: payment.status, toStatus: status, note: reason || status } }
  } });
  const eventType = status === 'SUCCESS' ? 'payment.succeeded' : status === 'EXPIRED' ? 'payment.expired' : 'payment.failed';
  const eventId = randomUUID();
  await tx.outboxEvent.create({ data: { id: eventId, aggregateId: payment.id, eventType, topic: 'finvault.events', payload: {
    eventId, eventType, eventVersion: 1, occurredAt: new Date().toISOString(), data: {
      paymentId: payment.id, senderId: payment.userId,
      ...(status === 'SUCCESS' ? { receiverId: payment.destinationUserId!, amount: payment.amount.toFixed(0) } :
        status === 'EXPIRED' ? {} : { reason: reason || status })
    }
  } } });
  return { ...updated, eventId };
}

export class P2pService {
  constructor(private wallet: WalletClient) {}
  async checkout(dto: Checkout) {
    if (dto.type !== 'WALLET_TRANSFER') throw new DomainException(422, 'UNSUPPORTED_PAYMENT_TYPE', 'Checkout supports wallet transfers');
    if (dto.userId === dto.destinationUserId) throw new DomainException(400, 'SAME_WALLET_TRANSFER', 'Wallets must differ');
    const amount = new Prisma.Decimal(dto.amount);
    if (!amount.isInteger() || !amount.isPositive()) throw new DomainException(400, 'INVALID_AMOUNT', 'Amount must be a positive whole VND value');
    const ownerType = dto.destinationOwnerType || 'USER';
    // Preserve the existing USER request hash while distinguishing other wallet owners.
    const hashData = [amount.toFixed(0), dto.type, dto.destinationUserId, dto.referenceId || ''];
    if (ownerType !== 'USER') hashData.push(ownerType);
    const hash = createHash('sha256').update(JSON.stringify(hashData)).digest('hex');
    let payment: Payment;
    try {
      payment = await prisma.payment.create({ data: {
        userId: dto.userId, destinationUserId: dto.destinationUserId, destinationOwnerType: ownerType, amount, type: dto.type,
        referenceId: dto.referenceId || '', callbackTopic: 'finvault.events', idempotencyKey: dto.idempotencyKey,
        requestHash: hash, idempotencyStatus: 'PROCESSING', idempotencyExpiresAt: new Date(Date.now()+86400000),
        holdId: randomUUID(), holdExpiresAt: new Date(Date.now()+300000), workflow: 'HOLDING',
        histories: { create: { toStatus: 'PENDING', note: 'Checkout requested' } }
      } });
    } catch (error: any) {
      if (error.code !== 'P2002') throw error;
      const previous = await prisma.payment.findUniqueOrThrow({ where: { userId_idempotencyKey: {
        userId: dto.userId, idempotencyKey: dto.idempotencyKey } } });
      if (previous.requestHash !== hash) throw new DomainException(422, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'Idempotency key has a different payload');
      if (previous.idempotencyStatus === 'COMPLETED') return { payment: previous, replayed: true };
      if (previous.idempotencyStatus === 'FAILED') throw new DomainException(409, 'CHECKOUT_FAILED', 'Previous checkout failed; use a new key');
      payment = previous;
    }
    // The original hold ID survives ambiguous HTTP failures and process restarts.
    const result = await this.completeHold(payment.id);
    if (result.error) throw result.error;
    return { payment: result.payment!, replayed: false };
  }

  async completeHold(id: string) {
    // -------------------------------------------------------------
    // PHA 1 (Transaction ngắn): Đọc trạng thái, kiểm tra điều kiện,
    // ghi ý định "chuẩn bị gọi ví" (claim việc) bằng UPDATE có điều kiện, commit.
    // -------------------------------------------------------------
    const claimResult = await prisma.$transaction(async tx => {
      const payment = await locked(tx, id);

      if (payment.idempotencyStatus === 'FAILED') {
        return { status: 'PREVIOUS_FAILED' as const, error: new DomainException(409, 'CHECKOUT_FAILED', 'Previous checkout failed') };
      }
      if (payment.idempotencyStatus === 'COMPLETED' && payment.workflow === 'IDLE') {
        return { status: 'ALREADY_COMPLETED' as const, payment };
      }

      const now = new Date();
      const leaseUntil = new Date(Date.now() + 30000);

      const updateResult = await tx.payment.updateMany({
        where: {
          id,
          status: 'PENDING',
          workflow: { in: ['HOLDING', 'HOLD_CALLING'] },
          OR: [
            { workerLeaseUntil: null },
            { workerLeaseUntil: { lte: now } },
            { workflow: 'HOLDING' }
          ]
        },
        data: {
          workflow: 'HOLD_CALLING',
          workerLeaseUntil: leaseUntil,
          attempt: { increment: 1 }
        }
      });

      if (updateResult.count === 0) {
        const current = await tx.payment.findUniqueOrThrow({ where: { id } });
        if (current.idempotencyStatus === 'COMPLETED') {
          return { status: 'ALREADY_COMPLETED' as const, payment: current };
        }
        if (current.idempotencyStatus === 'FAILED') {
          return { status: 'PREVIOUS_FAILED' as const, error: new DomainException(409, 'CHECKOUT_FAILED', 'Previous checkout failed') };
        }
        return { status: 'BUSY' as const, payment: current };
      }

      const claimedPayment = await tx.payment.findUniqueOrThrow({ where: { id } });
      return { status: 'CLAIMED' as const, payment: claimedPayment };
    }, transactionOptions);

    if (claimResult.status === 'PREVIOUS_FAILED') return { error: claimResult.error };
    if (claimResult.status === 'ALREADY_COMPLETED') return { payment: claimResult.payment };
    if (claimResult.status === 'BUSY') {
      return { error: new DomainException(503, 'WALLET_UNAVAILABLE', 'Payment checkout in progress by another worker') };
    }

    const payment = claimResult.payment!;
    const referenceId = payment.holdId!;
    const startTime = Date.now();

    // -------------------------------------------------------------
    // PHA 2 (NGOÀI Transaction): Gọi ví HTTP với referenceId lũy đẳng ổn định
    // -------------------------------------------------------------
    let walletOk = false;
    let deterministicError: DomainException | null = null;
    let indeterminateError: DomainException | null = null;

    try {
      await this.wallet.createHold(
        payment.userId,
        payment.amount.toString(),
        referenceId,
        payment.holdExpiresAt!.toISOString(),
        payment.destinationUserId!,
        payment.destinationOwnerType || 'USER'
      );
      walletOk = true;
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      if (error instanceof DomainException && error.status < 500) {
        deterministicError = error;
        console.warn(`[P2pService] completeHold 4xx deterministic error for payment ${payment.id} ref=${referenceId} code=${error.code} duration=${durationMs}ms`);
      } else {
        indeterminateError = error instanceof DomainException
          ? error
          : new DomainException(503, 'WALLET_UNAVAILABLE', 'Wallet unavailable; retry with the same key');
        console.error(`[P2pService] completeHold indeterminate error for payment ${payment.id} ref=${referenceId} duration=${durationMs}ms`);
      }
    }

    // -------------------------------------------------------------
    // PHA 3 (Transaction ngắn): Ghi kết quả bằng UPDATE có điều kiện
    // -------------------------------------------------------------
    if (walletOk) {
      const finalResult = await prisma.$transaction(async tx => {
        await tx.payment.updateMany({
          where: {
            id,
            workflow: 'HOLD_CALLING'
          },
          data: {
            workflow: 'IDLE',
            idempotencyStatus: 'COMPLETED',
            workerLeaseUntil: null
          }
        });

        const updated = await tx.payment.findUniqueOrThrow({ where: { id } });
        return { payment: updated };
      }, transactionOptions);

      return { payment: finalResult.payment };
    }

    if (deterministicError) {
      const finalResult = await prisma.$transaction(async tx => {
        const updateResult = await tx.payment.updateMany({
          where: {
            id,
            workflow: 'HOLD_CALLING'
          },
          data: {
            status: 'FAILED',
            workflow: 'IDLE',
            idempotencyStatus: 'FAILED',
            failureReason: deterministicError!.code,
            failureCode: deterministicError!.code,
            workerLeaseUntil: null
          }
        });

        if (updateResult.count === 1) {
          await tx.paymentHistory.create({
            data: {
              id: randomUUID(),
              paymentId: id,
              fromStatus: 'PENDING',
              toStatus: 'FAILED',
              note: `Hold failed: ${deterministicError!.code}`
            }
          });
        }

        const updated = await tx.payment.findUniqueOrThrow({ where: { id } });
        return { payment: updated };
      }, transactionOptions);

      return { error: deterministicError, payment: finalResult.payment };
    }

    // Lỗi không xác định: giữ nguyên HOLD_CALLING, nhả lease để worker tra cứu/thử lại
    await prisma.payment.updateMany({
      where: { id, workflow: 'HOLD_CALLING' },
      data: { workerLeaseUntil: null }
    }).catch(() => {});

    return { error: indeterminateError! };
  }

  async confirm(id: string, userId: string, token: string | TransactionTokenPayload) {
    const authorization = typeof token === 'string' ? verifyPaymentToken(token) : token;
    await prisma.$transaction(async tx => {
      const payment = await locked(tx, id);
      if (payment.userId !== userId || authorization.sub !== userId || authorization.paymentId !== id ||
          !payment.amount.equals(authorization.amount)) throw new DomainException(403, 'TXN_TOKEN_MISMATCH', 'Token does not authorize this payment');
      if (await tx.usedTransactionToken.findUnique({ where: { jti: authorization.jti } }))
        throw new DomainException(409, 'TXN_TOKEN_REUSED', 'Transaction token already used');
      if (payment.status !== 'PENDING' || payment.workflow !== 'IDLE' || payment.idempotencyStatus !== 'COMPLETED')
        throw new DomainException(409, 'PAYMENT_NOT_CONFIRMABLE', 'Payment cannot be confirmed');
      await tx.usedTransactionToken.create({ data: { jti: authorization.jti, paymentId: id, userId } });
      await tx.payment.update({ where: { id }, data: { workflow: 'CONFIRMING' } });
    }, transactionOptions);
    const result = await this.resume(id);
    if (result.status === 'EXPIRED') throw new DomainException(410, 'PAYMENT_EXPIRED', 'Payment hold expired');
    if (result.status === 'PENDING') throw new DomainException(503, 'PAYMENT_PROCESSING', 'Payment outcome is being reconciled; check its status');
    return result;
  }

  async resume(id: string) {
    const now = new Date();
    const leaseUntil = new Date(Date.now() + 30000);

    // -------------------------------------------------------------
    // PHA 1 (Transaction ngắn): Đọc trạng thái, claim việc theo workflow
    // -------------------------------------------------------------
    const claimResult = await prisma.$transaction(async tx => {
      const payment = await locked(tx, id);
      if (payment.status !== 'PENDING') return { status: 'FINAL' as const, payment };

      let targetWorkflow: string;
      let allowedWorkflows: string[];

      if (['CONFIRMING', 'CAPTURE_CALLING'].includes(payment.workflow)) {
        targetWorkflow = 'CAPTURE_CALLING';
        allowedWorkflows = ['CONFIRMING', 'CAPTURE_CALLING'];
      } else if (['RELEASING', 'RELEASE_CALLING'].includes(payment.workflow)) {
        targetWorkflow = 'RELEASE_CALLING';
        allowedWorkflows = ['RELEASING', 'RELEASE_CALLING'];
      } else {
        return { status: 'NOOP' as const, payment };
      }

      const updateResult = await tx.payment.updateMany({
        where: {
          id,
          status: 'PENDING',
          workflow: { in: allowedWorkflows },
          OR: [
            { workerLeaseUntil: null },
            { workerLeaseUntil: { lte: now } },
            { workflow: allowedWorkflows[0] }
          ]
        },
        data: {
          workflow: targetWorkflow,
          workerLeaseUntil: leaseUntil,
          attempt: { increment: 1 }
        }
      });

      if (updateResult.count === 0) {
        const current = await tx.payment.findUniqueOrThrow({ where: { id } });
        return { status: 'BUSY' as const, payment: current };
      }

      const claimed = await tx.payment.findUniqueOrThrow({ where: { id } });
      return { status: 'CLAIMED' as const, payment: claimed, mode: targetWorkflow };
    }, transactionOptions);

    if (claimResult.status === 'FINAL' || claimResult.status === 'NOOP') {
      return claimResult.payment;
    }
    if (claimResult.status === 'BUSY') {
      // Chờ tối đa vài trăm ms để worker đang giữ lease chốt kết quả nếu đang trong pha 2/3
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 100));
        const current = await prisma.payment.findUnique({ where: { id } });
        if (current && current.status !== 'PENDING') {
          return current;
        }
      }
      return claimResult.payment;
    }

    const payment = claimResult.payment;
    const mode = claimResult.mode;
    const referenceId = payment.holdId!;
    const startTime = Date.now();

    // -------------------------------------------------------------
    // PHA 2 (NGOÀI Transaction): Tra cứu và gọi ví HTTP lũy đẳng
    // -------------------------------------------------------------
    type Outcome =
      | { type: 'SUCCESS' }
      | { type: 'FINAL_ERROR'; status: PaymentStatus; reason: string }
      | { type: 'INDETERMINATE'; error: any };

    let outcome: Outcome = { type: 'INDETERMINATE', error: new Error('Unresolved') };

    if (mode === 'CAPTURE_CALLING') {
      try {
        // Nếu đã từng thử trước đó (attempt > 1 hoặc đang ở CAPTURE_CALLING): tra cứu ví trước
        if (payment.attempt > 1) {
          try {
            const lookup = await this.wallet.lookupTransaction(referenceId);
            if (lookup?.exists && lookup.status === 'COMPLETED') {
              console.log(`[P2pService] resume: lookup found capture already completed for payment ${id} ref=${referenceId}`);
              outcome = { type: 'SUCCESS' };
            }
          } catch (lookupErr) {
            console.warn(`[P2pService] resume: lookup failed for payment ${id}, will proceed with capture`, lookupErr);
          }
        }

        if (outcome.type !== 'SUCCESS') {
          await this.wallet.captureHold(payment.userId, referenceId);
          outcome = { type: 'SUCCESS' };
        }
      } catch (captureErr: any) {
        const durationMs = Date.now() - startTime;
        if (captureErr instanceof DomainException && captureErr.status < 500) {
          const expired = ['HOLD_EXPIRED', 'HOLD_NOT_CAPTURABLE'].includes(captureErr.code);
          const failureReason = expired ? 'HOLD_EXPIRED' : 'CAPTURE_FAILED';
          console.warn(`[P2pService] resume capture 4xx for payment ${id} ref=${referenceId} reason=${failureReason} duration=${durationMs}ms`);

          // Thử nhả hold ở ví ngoài transaction
          try {
            await this.wallet.releaseHold(payment.userId, referenceId);
            outcome = {
              type: 'FINAL_ERROR',
              status: expired ? 'EXPIRED' : 'FAILED',
              reason: failureReason
            };
          } catch (releaseErr: any) {
            if (releaseErr instanceof DomainException && releaseErr.code === 'HOLD_ALREADY_CAPTURED') {
              // Trường hợp đua lệnh: hold đã được capture
              outcome = { type: 'SUCCESS' };
            } else if (releaseErr instanceof DomainException && ['HOLD_ALREADY_RELEASED', 'HOLD_EXPIRED', 'HOLD_NOT_CAPTURABLE'].includes(releaseErr.code)) {
              outcome = {
                type: 'FINAL_ERROR',
                status: expired ? 'EXPIRED' : 'FAILED',
                reason: failureReason
              };
            } else {
              outcome = { type: 'INDETERMINATE', error: releaseErr };
            }
          }
        } else {
          // Lỗi không xác định (timeout/503)
          outcome = { type: 'INDETERMINATE', error: captureErr };
        }
      }
    } else if (mode === 'RELEASE_CALLING') {
      try {
        await this.wallet.releaseHold(payment.userId, referenceId);
        outcome = {
          type: 'FINAL_ERROR',
          status: payment.failureReason === 'HOLD_EXPIRED' ? 'EXPIRED' : 'FAILED',
          reason: payment.failureReason || 'CAPTURE_FAILED'
        };
      } catch (releaseErr: any) {
        if (releaseErr instanceof DomainException && releaseErr.code === 'HOLD_ALREADY_CAPTURED') {
          try {
            await this.wallet.captureHold(payment.userId, referenceId);
            outcome = { type: 'SUCCESS' };
          } catch (e) {
            outcome = { type: 'INDETERMINATE', error: e };
          }
        } else if (releaseErr instanceof DomainException && ['HOLD_ALREADY_RELEASED', 'HOLD_EXPIRED', 'HOLD_NOT_CAPTURABLE'].includes(releaseErr.code)) {
          outcome = {
            type: 'FINAL_ERROR',
            status: payment.failureReason === 'HOLD_EXPIRED' ? 'EXPIRED' : 'FAILED',
            reason: payment.failureReason || 'CAPTURE_FAILED'
          };
        } else {
          outcome = { type: 'INDETERMINATE', error: releaseErr };
        }
      }
    }

    // -------------------------------------------------------------
    // PHA 3 (Transaction ngắn): Chốt kết quả & ghi OutboxEvent
    // -------------------------------------------------------------
    if (outcome.type === 'SUCCESS') {
      const finalResult = await prisma.$transaction(async tx => {
        const updateResult = await tx.payment.updateMany({
          where: {
            id,
            status: 'PENDING',
            workflow: { in: ['CAPTURE_CALLING', 'RELEASE_CALLING', 'CONFIRMING'] }
          },
          data: { workerLeaseUntil: null }
        });
        if (updateResult.count === 0) {
          return await tx.payment.findUniqueOrThrow({ where: { id } });
        }
        return await finish(tx, payment, 'SUCCESS');
      }, transactionOptions);

      void drainOutbox().catch(() => {});
      return finalResult;
    }

    if (outcome.type === 'FINAL_ERROR') {
      const finalStatus = outcome.status;
      const finalReason = outcome.reason;

      const finalResult = await prisma.$transaction(async tx => {
        const updateResult = await tx.payment.updateMany({
          where: {
            id,
            status: 'PENDING',
            workflow: { in: ['CAPTURE_CALLING', 'RELEASE_CALLING', 'RELEASING'] }
          },
          data: { workerLeaseUntil: null }
        });
        if (updateResult.count === 0) {
          return await tx.payment.findUniqueOrThrow({ where: { id } });
        }
        return await finish(tx, payment, finalStatus, finalReason);
      }, transactionOptions);

      void drainOutbox().catch(() => {});
      return finalResult;
    }

    // Lỗi không xác định: Giữ nguyên workflow, nhả lease để retry
    await prisma.payment.updateMany({
      where: { id, workflow: { in: ['CAPTURE_CALLING', 'RELEASE_CALLING'] } },
      data: { workerLeaseUntil: null }
    }).catch(() => {});

    return payment;
  }

  async cancel(id: string, userId?: string, expired = false) {
    const leaseUntil = new Date(Date.now() + 30000);

    // Pha 1: Transaction ngắn kiểm tra điều kiện và claim CANCEL_CALLING
    const claimResult = await prisma.$transaction(async tx => {
      const payment = await locked(tx, id);
      if (userId !== undefined && payment.userId !== userId) {
        throw new DomainException(403, 'FORBIDDEN', 'Payment belongs to another user');
      }
      if (payment.status !== 'PENDING' || !['IDLE', 'HOLDING', 'CANCEL_CALLING'].includes(payment.workflow)) {
        throw new DomainException(409, 'CONFLICT', 'Payment cannot be cancelled');
      }
      if (expired && payment.holdExpiresAt && payment.holdExpiresAt > new Date()) {
        return { status: 'NOT_YET_EXPIRED' as const, payment };
      }

      await tx.payment.update({
        where: { id },
        data: {
          workflow: 'CANCEL_CALLING',
          workerLeaseUntil: leaseUntil
        }
      });

      return { status: 'CLAIMED' as const, payment };
    }, transactionOptions);

    if (claimResult.status === 'NOT_YET_EXPIRED') return claimResult.payment;

    const payment = claimResult.payment;

    // Pha 2: Gọi ví releaseHold NGOÀI transaction
    if (payment.holdId) {
      try {
        await this.wallet.releaseHold(payment.userId, payment.holdId);
      } catch (err: any) {
        const isHandled = err instanceof DomainException &&
          ['HOLD_EXPIRED', 'HOLD_NOT_CAPTURABLE', 'HOLD_ALREADY_RELEASED'].includes(err.code);
        if (!isHandled) {
          console.warn(`[P2pService] cancel releaseHold error for payment ${id}:`, err?.message || err);
        }
      }
    }

    // Pha 3: Transaction ngắn chốt kết quả và OutboxEvent
    const finalResult = await prisma.$transaction(async tx => {
      return finish(tx, payment, expired ? 'EXPIRED' : 'CANCELLED');
    }, transactionOptions);

    void drainOutbox().catch(() => {});
    return finalResult;
  }

  async recover() {
    const pending = await prisma.payment.findMany({ where: { status: 'PENDING', type: 'WALLET_TRANSFER', destinationUserId: { not: null },
      OR: [{ workflow: { not: 'IDLE' } }, { holdExpiresAt: { lt: new Date() } }] }, take: 50, orderBy: { updatedAt: 'asc' } });
    for (const payment of pending) {
      try {
        if (payment.workflow === 'HOLDING' || payment.workflow === 'HOLD_CALLING') await this.completeHold(payment.id);
        else if (payment.workflow !== 'IDLE') await this.resume(payment.id);
        else await this.cancel(payment.id, undefined, true);
      } catch { console.error('[Payment] Recovery will retry', payment.id); }
    }
  }
}
