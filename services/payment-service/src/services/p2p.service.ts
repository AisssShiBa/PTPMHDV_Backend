import { createHash, randomUUID } from 'node:crypto';
import { Payment, Prisma, PaymentStatus } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { DomainException } from '../utils/domain.exception';
import { verifyPaymentToken } from '../utils/transaction-token';
import { WalletClient } from '../clients/wallet.client';

type Checkout = { userId: string; destinationUserId: string; amount: string | number;
  type: any; referenceId?: string; callbackTopic?: string; idempotencyKey: string };
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
    const hash = createHash('sha256').update(JSON.stringify([amount.toFixed(0), dto.type, dto.destinationUserId, dto.referenceId || ''])).digest('hex');
    let payment: Payment;
    try {
      payment = await prisma.payment.create({ data: {
        userId: dto.userId, destinationUserId: dto.destinationUserId, amount, type: dto.type,
        referenceId: dto.referenceId || '', callbackTopic: 'finvault.events', idempotencyKey: dto.idempotencyKey,
        requestHash: hash, idempotencyStatus: 'PROCESSING', idempotencyExpiresAt: new Date(Date.now()+86400000),
        holdId: randomUUID(), holdExpiresAt: new Date(Date.now()+900000), workflow: 'HOLDING',
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
    return prisma.$transaction(async tx => {
      const payment = await locked(tx, id);
      if (payment.idempotencyStatus === 'FAILED') return { error: new DomainException(409, 'CHECKOUT_FAILED', 'Previous checkout failed') };
      if (payment.workflow !== 'HOLDING') return { payment };
      try {
        await this.wallet.createHold(payment.userId, payment.amount.toString(), payment.holdId!, payment.holdExpiresAt!.toISOString(), payment.destinationUserId!);
        return { payment: await tx.payment.update({ where: { id }, data: { workflow: 'IDLE', idempotencyStatus: 'COMPLETED' } }) };
      } catch (error) {
        if (error instanceof DomainException && error.status < 500) {
          await tx.payment.update({ where: { id }, data: { status: 'FAILED', workflow: 'IDLE', idempotencyStatus: 'FAILED', failureReason: error.code } });
        }
        return { error: error instanceof DomainException ? error : new DomainException(503, 'WALLET_UNAVAILABLE', 'Wallet unavailable; retry with the same key') };
      }
    }, transactionOptions);
  }

  async confirm(id: string, userId: string, token: string) {
    const authorization = verifyPaymentToken(token);
    await prisma.$transaction(async tx => {
      const payment = await locked(tx, id);
      if (payment.userId !== userId || authorization.sub !== userId || authorization.paymentId !== id ||
          !payment.amount.equals(authorization.amount)) throw new DomainException(403, 'TXN_TOKEN_MISMATCH', 'Token does not authorize this payment');
      if (await tx.usedTransactionToken.findUnique({ where: { jti: authorization.jti } }))
        throw new DomainException(409, 'TXN_TOKEN_REUSED', 'Transaction token already used');
      if (payment.status !== 'PENDING' || payment.workflow !== 'IDLE' || payment.idempotencyStatus !== 'COMPLETED')
        throw new DomainException(409, 'PAYMENT_NOT_CONFIRMABLE', 'Payment cannot be confirmed');
      await tx.usedTransactionToken.create({ data: { jti: authorization.jti, paymentId: id } });
      await tx.payment.update({ where: { id }, data: { workflow: 'CONFIRMING' } });
    }, transactionOptions);
    const result = await this.resume(id);
    if (result.status === 'PENDING') throw new DomainException(503, 'PAYMENT_PROCESSING', 'Payment outcome is being reconciled; check its status');
    return result;
  }

  async resume(id: string) {
    return prisma.$transaction(async tx => {
      let payment = await locked(tx, id);
      if (payment.status !== 'PENDING') return payment;
      if (payment.workflow === 'CONFIRMING') {
        try {
          await this.wallet.captureHold(payment.userId, payment.holdId!);
        } catch (error) {
          // Do not compensate a possibly captured transfer with an unrelated credit.
          // A release distinguishes a captured hold from an uncaptured one.
          payment = await tx.payment.update({ where: { id }, data: { workflow: 'RELEASING' } });
        }
        if (payment.workflow === 'CONFIRMING') return finish(tx, payment, 'SUCCESS');
      }
      if (payment.workflow === 'RELEASING') {
        try {
          await this.wallet.releaseHold(payment.userId, payment.holdId!);
        } catch (error) {
          if (error instanceof DomainException && error.code === 'HOLD_ALREADY_CAPTURED') {
            await this.wallet.captureHold(payment.userId, payment.holdId!);
            return await finish(tx, payment, 'SUCCESS');
          }
          return payment; // Durable worker retries after Wallet recovers.
        }
        return finish(tx, payment, 'FAILED', 'CAPTURE_FAILED');
      }
      return payment;
    }, transactionOptions);
  }

  async cancel(id: string, userId?: string, expired = false) {
    return prisma.$transaction(async tx => {
      const payment = await locked(tx, id);
      if (userId !== undefined && payment.userId !== userId) throw new DomainException(403, 'FORBIDDEN', 'Payment belongs to another user');
      if (payment.status !== 'PENDING' || !['IDLE','HOLDING'].includes(payment.workflow))
        throw new DomainException(409, 'CONFLICT', 'Payment cannot be cancelled');
      if (expired && payment.holdExpiresAt && payment.holdExpiresAt > new Date()) return payment;
      if (payment.holdId) await this.wallet.releaseHold(payment.userId, payment.holdId);
      return finish(tx, payment, expired ? 'EXPIRED' : 'CANCELLED');
    }, transactionOptions);
  }

  async recover() {
    const pending = await prisma.payment.findMany({ where: { status: 'PENDING', destinationUserId: { not: null },
      OR: [{ workflow: { not: 'IDLE' } }, { holdExpiresAt: { lt: new Date() } }] }, take: 50, orderBy: { updatedAt: 'asc' } });
    for (const payment of pending) {
      try {
        if (payment.workflow === 'HOLDING') await this.completeHold(payment.id);
        else if (payment.workflow !== 'IDLE') await this.resume(payment.id);
        else await this.cancel(payment.id, undefined, true);
      } catch { console.error('[Payment] Recovery will retry', payment.id); }
    }
  }
}
