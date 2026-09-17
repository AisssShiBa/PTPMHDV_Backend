import { PaymentStatus, OutboxEventStatus, PaymentType } from '../utils/enums';

export interface PaymentMock {
  id: string;
  userId: string;
  amount: string;
  type: PaymentType;
  referenceId: string;
  callbackTopic: string;
  idempotencyKey: string;
  status: PaymentStatus;
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentHistoryMock {
  id: string;
  paymentId: string;
  fromStatus?: PaymentStatus;
  toStatus: PaymentStatus;
  note?: string;
  changedAt: Date;
}

export interface OutboxEventMock {
  id: string;
  aggregateId: string;
  eventType: string;
  topic: string;
  payload: any;
  status: OutboxEventStatus;
  createdAt: Date;
  sentAt?: Date;
}

export class MockDbService {
  public payments: PaymentMock[] = [
    {
      id: 'mock-payment-1',
      userId: 'user-123',
      amount: '50000',
      type: PaymentType.CARD_TOPUP,
      referenceId: 'ref-1',
      callbackTopic: 'payment.topup',
      idempotencyKey: 'idem-key-1',
      status: PaymentStatus.SUCCESS,
      createdAt: new Date('2026-09-01T10:00:00Z'),
      updatedAt: new Date('2026-09-01T10:00:05Z'),
    },
    {
      id: 'mock-payment-2',
      userId: 'user-456',
      amount: '120000',
      type: PaymentType.BUS_TICKET,
      referenceId: 'ref-2',
      callbackTopic: 'payment.ticket',
      idempotencyKey: 'idem-key-2',
      status: PaymentStatus.PENDING,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
  ];

  public histories: PaymentHistoryMock[] = [
    {
      id: 'mock-hist-1',
      paymentId: 'mock-payment-1',
      toStatus: PaymentStatus.PENDING,
      note: 'Payment checkout created',
      changedAt: new Date('2026-09-01T10:00:00Z'),
    },
    {
      id: 'mock-hist-2',
      paymentId: 'mock-payment-1',
      fromStatus: PaymentStatus.PENDING,
      toStatus: PaymentStatus.SUCCESS,
      note: 'Wallet debit successful',
      changedAt: new Date('2026-09-01T10:00:05Z'),
    }
  ];

  public outboxEvents: OutboxEventMock[] = [];
}
