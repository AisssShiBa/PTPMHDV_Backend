import { DomainException } from '../utils/domain.exception';
export interface CheckoutDto {
  userId: string;
  amount: number;
  type: PaymentType;
  referenceId?: string;
  callbackTopic: string;
  idempotencyKey: string;
}
import { PaymentStatus, OutboxEventStatus, PaymentType } from '../utils/enums';
import { MockDbService, PaymentMock } from './mock-db.service';
import { randomUUID } from 'crypto';

export class PaymentService {
  constructor(private db: MockDbService = new MockDbService()) {}

  async checkout(dto: CheckoutDto) {
    const existing = this.db.payments.find(p => p.idempotencyKey === dto.idempotencyKey);
    if (existing) {
      console.log(`Idempotency key ${dto.idempotencyKey} already exists. Returning existing payment.`);
      return existing;
    }

    const payment: PaymentMock = {
      id: randomUUID(),
      userId: dto.userId,
      amount: dto.amount.toString(),
      type: dto.type,
      referenceId: dto.referenceId,
      callbackTopic: dto.callbackTopic,
      idempotencyKey: dto.idempotencyKey,
      status: PaymentStatus.PENDING,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.db.payments.push(payment);

    this.db.histories.push({
      id: randomUUID(),
      paymentId: payment.id,
      toStatus: PaymentStatus.PENDING,
      note: 'Payment checkout created',
      changedAt: new Date(),
    });

    return payment;
  }

  async confirm(id: string) {
    const payment = this.db.payments.find(p => p.id === id);
    if (!payment) throw new DomainException(404, 'NOT_FOUND', 'Payment not found');
    if (payment.status !== PaymentStatus.PENDING) {
      throw new DomainException(409, 'CONFLICT', `Payment is in ${payment.status} status. Cannot confirm.`);
    }

    try {
      // Call Wallet Service Debit
      const response = await fetch(`${process.env.WALLET_SERVICE_URL}/api/v1/internal/wallets/${payment.userId}/debit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-key': 'replace-with-a-shared-internal-secret'
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

      // Success
      payment.status = PaymentStatus.SUCCESS;
      payment.updatedAt = new Date();

      this.db.histories.push({
        id: randomUUID(),
        paymentId: id,
        fromStatus: PaymentStatus.PENDING,
        toStatus: PaymentStatus.SUCCESS,
        note: 'Wallet debit successful',
        changedAt: new Date(),
      });

      this.db.outboxEvents.push({
        id: randomUUID(),
        aggregateId: id,
        eventType: 'PAYMENT_SUCCESS',
        topic: payment.callbackTopic,
        payload: { ...payment },
        status: OutboxEventStatus.PENDING,
        createdAt: new Date(),
      });

      return payment;
    } catch (error: any) {
      console.error(`Confirm payment failed for ${id}:`, error);

      // Failed
      payment.status = PaymentStatus.FAILED;
      payment.failureReason = error.message;
      payment.updatedAt = new Date();

      this.db.histories.push({
        id: randomUUID(),
        paymentId: id,
        fromStatus: PaymentStatus.PENDING,
        toStatus: PaymentStatus.FAILED,
        note: error.message,
        changedAt: new Date(),
      });

      this.db.outboxEvents.push({
        id: randomUUID(),
        aggregateId: id,
        eventType: 'PAYMENT_FAILED',
        topic: payment.callbackTopic,
        payload: { ...payment },
        status: OutboxEventStatus.PENDING,
        createdAt: new Date(),
      });

      return payment;
    }
  }

  async refund(id: string) {
    const payment = this.db.payments.find(p => p.id === id);
    if (!payment) throw new DomainException(404, 'NOT_FOUND', 'Payment not found');
    if (payment.status !== PaymentStatus.SUCCESS) {
      throw new DomainException(409, 'CONFLICT', `Payment is in ${payment.status} status. Cannot refund.`);
    }

    try {
      const response = await fetch(`${process.env.WALLET_SERVICE_URL}/api/v1/internal/wallets/${payment.userId}/credit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-key': 'replace-with-a-shared-internal-secret'
        },
        body: JSON.stringify({
          amount: payment.amount.toString(),
          referenceId: `refund_${payment.id}`
        })
      });

      if (!response.ok) {
        throw new Error('Credit failed');
      }

      payment.status = PaymentStatus.REFUNDED;
      payment.updatedAt = new Date();

      this.db.histories.push({
        id: randomUUID(),
        paymentId: id,
        fromStatus: PaymentStatus.SUCCESS,
        toStatus: PaymentStatus.REFUNDED,
        note: 'Refund successful',
        changedAt: new Date(),
      });

      this.db.outboxEvents.push({
        id: randomUUID(),
        aggregateId: id,
        eventType: 'PAYMENT_REFUNDED',
        topic: payment.callbackTopic,
        payload: { ...payment },
        status: OutboxEventStatus.PENDING,
        createdAt: new Date(),
      });

      return payment;
    } catch (error: any) {
      console.error(`Refund payment failed for ${id}:`, error);
      throw new DomainException(500, 'INTERNAL_ERROR', 'Refund failed');
    }
  }

  async cancel(id: string) {
    const payment = this.db.payments.find(p => p.id === id);
    if (!payment) throw new DomainException(404, 'NOT_FOUND', 'Payment not found');
    if (payment.status !== PaymentStatus.PENDING) {
      throw new DomainException(409, 'CONFLICT', `Payment is in ${payment.status} status. Cannot cancel.`);
    }

    payment.status = PaymentStatus.CANCELLED;
    payment.updatedAt = new Date();

    this.db.histories.push({
      id: randomUUID(),
      paymentId: id,
      fromStatus: PaymentStatus.PENDING,
      toStatus: PaymentStatus.CANCELLED,
      note: 'User cancelled',
      changedAt: new Date(),
    });

    return payment;
  }

  async getById(id: string) {
    const payment = this.db.payments.find(p => p.id === id);
    if (!payment) return null;
    
    const history = this.db.histories.filter(h => h.paymentId === id);
    return { ...payment, history };
  }

  async list(userId?: string, type?: string, status?: string) {
    return this.db.payments.filter(p => {
      if (userId && p.userId !== userId) return false;
      if (type && p.type !== type) return false;
      if (status && p.status !== status) return false;
      return true;
    });
  }
}
