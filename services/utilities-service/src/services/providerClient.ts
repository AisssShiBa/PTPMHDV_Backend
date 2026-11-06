import { env } from '../config/env'
import type { ProviderClient, ProviderOutcome } from '../types/utility'

const outcomeFromPayload = (status: number, payload: any): ProviderOutcome => {
  if (status === 504) return { status: 'TIMEOUT' }
  if (status >= 200 && status < 300) {
    const value = payload?.data?.status
    if (value === 'SUCCESS' && typeof payload.data.providerRef === 'string') {
      return { status: 'SUCCESS', providerRef: payload.data.providerRef }
    }
    if (value === 'TIMEOUT') return { status: 'TIMEOUT' }
    if (value === 'FAILED') {
      return {
        status: 'FAILED',
        reason: typeof payload.data.reason === 'string' ? payload.data.reason : 'PROVIDER_REJECTED'
      }
    }
    return { status: 'TIMEOUT' }
  }
  if (status >= 400 && status < 500) {
    return {
      status: 'FAILED',
      reason: typeof payload?.error?.code === 'string' ? payload.error.code : 'PROVIDER_REJECTED'
    }
  }
  return { status: 'TIMEOUT' }
}

export class HttpProviderClient implements ProviderClient {
  constructor(
    private readonly baseUrl: string = env.providerBaseUrl,
    private readonly internalKey: string = env.internalKey,
    private readonly timeoutMs: number = env.providerTimeoutMs
  ) {}

  private async request(path: string, init: RequestInit): Promise<ProviderOutcome> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          'x-internal-key': this.internalKey,
          ...init.headers
        },
        signal: AbortSignal.timeout(this.timeoutMs)
      })
      let payload: any
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      return outcomeFromPayload(response.status, payload)
    } catch {
      // Network errors and client-side aborts share the same business meaning:
      // money may have moved, but the result is unknown.
      return { status: 'TIMEOUT' }
    }
  }

  topup(input: { orderId: string; phone: string; amount: string }): Promise<ProviderOutcome> {
    return this.request('/internal/mock-provider/topup', {
      method: 'POST',
      body: JSON.stringify(input)
    })
  }

  payBill(input: {
    orderId: string
    providerCode: string
    customerCode: string
    amount: string
  }): Promise<ProviderOutcome> {
    return this.request('/internal/mock-provider/topup', {
      method: 'POST',
      body: JSON.stringify({
        orderId: input.orderId,
        phone: input.customerCode,
        amount: input.amount
      })
    })
  }

  getStatus(orderId: string): Promise<ProviderOutcome> {
    return this.request(`/internal/mock-provider/orders/${encodeURIComponent(orderId)}`, {
      method: 'GET'
    })
  }
}
