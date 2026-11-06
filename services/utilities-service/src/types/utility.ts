import type { UtilityOrder, UtilityType } from '@prisma/client'

export type ProviderOutcome =
  | { status: 'SUCCESS'; providerRef: string }
  | { status: 'FAILED'; reason: string }
  | { status: 'TIMEOUT' }

export type CheckoutRequest = {
  amount: string
  type: 'PHONE_TOPUP' | 'BILL_PAYMENT'
  referenceId: string
  idempotencyKey: string
}

export type CheckoutResponse = {
  paymentId: string
  status: string
  replayed: boolean
}

export type RefundStatus = 'REFUNDED' | 'REFUNDING' | 'UNKNOWN'

export interface PaymentClient {
  checkout(request: CheckoutRequest, gatewayToken: string, requestId?: string): Promise<CheckoutResponse>
  requestRefund(paymentId: string): Promise<RefundStatus>
  getRefundStatus(paymentId: string): Promise<RefundStatus>
}

export interface ProviderClient {
  topup(input: { orderId: string; phone: string; amount: string }): Promise<ProviderOutcome>
  payBill(input: {
    orderId: string
    providerCode: string
    customerCode: string
    amount: string
  }): Promise<ProviderOutcome>
  getStatus(orderId: string): Promise<ProviderOutcome>
}

export type OrderView = {
  orderId: string
  type: UtilityType
  status: UtilityOrder['status']
  amount: string
  discountAmount: string
  target: string
  providerCode: string | null
  providerRef: string | null
  paymentId: string | null
  failureReason: string | null
  createdAt: Date
  updatedAt: Date
  replayed?: boolean
}
