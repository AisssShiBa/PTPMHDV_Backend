import './setup'
import { randomUUID } from 'node:crypto'
import { createTestGatewayToken } from 'finvault-internal-auth'
import type { UtilityOrder } from '@prisma/client'
import { prisma } from '../src/config/prisma'
import { createUtilityApp } from '../src/app'
import { MockProviderEngine } from '../src/services/mockProviderEngine'
import type {
  CheckoutRequest,
  CheckoutResponse,
  PaymentClient,
  ProviderClient,
  ProviderOutcome,
  RefundStatus
} from '../src/types/utility'

export const USER_ID = '11111111-1111-4111-8111-111111111111'
export const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222'

export const tokenFor = (userId = USER_ID) => createTestGatewayToken(userId, 'USER')

export type CheckoutCall = {
  request: CheckoutRequest
  gatewayToken: string
  requestId?: string
}

export class FakePaymentClient implements PaymentClient {
  readonly checkouts: CheckoutCall[] = []
  readonly refundCalls: string[] = []
  checkoutHandler: (request: CheckoutRequest, gatewayToken: string) => Promise<CheckoutResponse> =
    async request => ({
      paymentId: `pay-${request.referenceId}`,
      status: 'PENDING',
      replayed: false
    })
  refundHandler: (paymentId: string) => Promise<RefundStatus> = async () => 'REFUNDED'

  async checkout(
    request: CheckoutRequest,
    gatewayToken: string,
    requestId?: string
  ): Promise<CheckoutResponse> {
    this.checkouts.push({ request, gatewayToken, requestId })
    return this.checkoutHandler(request, gatewayToken)
  }

  async requestRefund(paymentId: string): Promise<RefundStatus> {
    this.refundCalls.push(paymentId)
    return this.refundHandler(paymentId)
  }

  async getRefundStatus(_paymentId: string): Promise<RefundStatus> {
    return 'UNKNOWN'
  }
}

export class FakeProviderClient implements ProviderClient {
  readonly calls: Array<{ orderId: string; phone?: string; customerCode?: string }> = []
  outcome: ProviderOutcome = { status: 'SUCCESS', providerRef: 'MOCK-provider' }
  queryOutcome: ProviderOutcome = { status: 'SUCCESS', providerRef: 'MOCK-provider' }

  async topup(input: { orderId: string; phone: string; amount: string }): Promise<ProviderOutcome> {
    this.calls.push({ orderId: input.orderId, phone: input.phone })
    return this.outcome
  }

  async payBill(input: {
    orderId: string
    providerCode: string
    customerCode: string
    amount: string
  }): Promise<ProviderOutcome> {
    this.calls.push({ orderId: input.orderId, customerCode: input.customerCode })
    return this.outcome
  }

  async getStatus(orderId: string): Promise<ProviderOutcome> {
    this.calls.push({ orderId })
    return this.queryOutcome
  }
}

export const testApp = (options: { mockProviderEnabled?: boolean } = {}) => {
  const paymentClient = new FakePaymentClient()
  const providerClient = new FakeProviderClient()
  const app = createUtilityApp({
    paymentClient,
    providerClient,
    mockProviderEngine: new MockProviderEngine(),
    mockProviderEnabled: options.mockProviderEnabled ?? false
  })
  return { app, paymentClient, providerClient }
}

export const clearDatabase = async () => {
  await prisma.utilityOrderHistory.deleteMany()
  await prisma.utilityOrder.deleteMany()
  await prisma.utilityInbox.deleteMany()
}

export const createOrder = async (
  overrides: Partial<UtilityOrder> & { paymentId: string | null } = { paymentId: null }
) =>
  prisma.utilityOrder.create({
    data: {
      userId: USER_ID,
      type: 'TELCO_TOPUP',
      status: 'PENDING_PAYMENT',
      amount: '50000',
      discountAmount: '1500',
      target: '0912345600',
      idempotencyKey: overrides.idempotencyKey ?? randomUUID(),
      payloadHash: overrides.payloadHash ?? 'hash',
      ...overrides
    }
  })

export const eventOf = (eventType: string, data: unknown, eventId = randomUUID()) => ({
  eventId,
  eventType,
  eventVersion: 1,
  occurredAt: '2026-11-06T00:00:00.000Z',
  data
})
