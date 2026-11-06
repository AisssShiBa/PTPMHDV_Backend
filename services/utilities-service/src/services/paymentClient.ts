import { env } from '../config/env'
import type { CheckoutRequest, CheckoutResponse, PaymentClient, RefundStatus } from '../types/utility'

export class PaymentClientError extends Error {
  constructor(
    message: string,
    public readonly status: number | undefined,
    public readonly upstreamCode: string | undefined,
    // A definite 4xx answer means payment-service rejected the request and
    // no payment will be created. Anything else may still have succeeded.
    public readonly definite: boolean
  ) {
    super(message)
    this.name = 'PaymentClientError'
  }
}

const refundStatusFrom = (value: unknown): RefundStatus => {
  if (value === 'REFUNDED') return 'REFUNDED'
  if (value === 'REFUNDING' || value === 'REFUND_REQUESTED') return 'REFUNDING'
  return 'UNKNOWN'
}

export class HttpPaymentClient implements PaymentClient {
  constructor(
    private readonly baseUrl: string = env.paymentServiceUrl,
    private readonly internalKey: string = env.internalKey,
    private readonly timeoutMs = 10_000
  ) {}

  async checkout(
    request: CheckoutRequest,
    gatewayToken: string,
    requestId?: string
  ): Promise<CheckoutResponse> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/payments/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Forward the caller's Gateway token unchanged; never add the
          // service key to a user-facing checkout.
          'x-gateway-token': gatewayToken,
          'Idempotency-Key': request.idempotencyKey,
          ...(requestId === undefined ? {} : { 'x-request-id': requestId })
        },
        body: JSON.stringify({
          amount: request.amount,
          type: request.type,
          referenceId: request.referenceId,
          idempotencyKey: request.idempotencyKey
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch {
      throw new PaymentClientError('Payment service is unavailable', undefined, undefined, false)
    }

    let payload: any
    try {
      payload = await response.json()
    } catch {
      payload = undefined
    }

    if (!response.ok) {
      const code = payload?.error?.code
      const definite = response.status >= 400 && response.status < 500
      throw new PaymentClientError(
        definite ? 'Payment request rejected' : 'Payment service is unavailable',
        response.status,
        typeof code === 'string' ? code : undefined,
        definite
      )
    }

    // payment-service returns its Payment row, whose primary key is `id`.
    // `paymentId` is kept as a fallback for older mocks/deployments.
    const data = payload?.data
    const paymentId =
      typeof data?.id === 'string' && data.id.length > 0 ? data.id : data?.paymentId
    if (typeof paymentId !== 'string' || paymentId.length === 0) {
      throw new PaymentClientError(
        'Payment response is missing id/paymentId',
        undefined,
        undefined,
        false
      )
    }
    return {
      paymentId,
      status: typeof data?.status === 'string' ? data.status : 'PENDING',
      replayed: data?.replayed === true
    }
  }

  async requestRefund(paymentId: string): Promise<RefundStatus> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/payments/${encodeURIComponent(paymentId)}/refund`, {
        method: 'POST',
        headers: { 'x-internal-key': this.internalKey },
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch {
      throw new PaymentClientError('Payment service is unavailable', undefined, undefined, false)
    }

    let payload: any
    try {
      payload = await response.json()
    } catch {
      payload = undefined
    }

    if (!response.ok) {
      const definite = response.status >= 400 && response.status < 500
      const code = payload?.error?.code
      throw new PaymentClientError(
        definite ? 'Refund rejected' : 'Refund outcome unknown',
        response.status,
        typeof code === 'string' ? code : undefined,
        definite
      )
    }

    return refundStatusFrom(payload?.data?.status)
  }

  // No internal refund-status endpoint exists on main yet. K13 must add one;
  // until then this deliberately reports UNKNOWN instead of guessing.
  async getRefundStatus(_paymentId: string): Promise<RefundStatus> {
    return 'UNKNOWN'
  }
}
