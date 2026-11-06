import type { ProviderOutcome } from '../types/utility'

type MockRecord = {
  outcome: ProviderOutcome
  queried: boolean
  delivered: boolean
}

// Deterministic sandbox provider. Every order is decided from the last two
// digits of the phone/customer code: 11 = rejected, 22 = timeout on the first
// attempt, everything else = success. Results are stored per orderId so a
// duplicate callback never creates a second top-up.
export class MockProviderEngine {
  private readonly records = new Map<string, MockRecord>()

  private static scenario(key: string): 'REJECT' | 'TIMEOUT' | 'SUCCESS' {
    const tail = key.slice(-2)
    if (tail === '11') return 'REJECT'
    if (tail === '22') return 'TIMEOUT'
    return 'SUCCESS'
  }

  private static initialOutcome(orderId: string, key: string): ProviderOutcome {
    const scenario = MockProviderEngine.scenario(key)
    if (scenario === 'REJECT') return { status: 'FAILED', reason: 'PROVIDER_REJECTED' }
    if (scenario === 'TIMEOUT') return { status: 'TIMEOUT' }
    return { status: 'SUCCESS', providerRef: `MOCK-${orderId}` }
  }

  execute(input: { orderId: string; key: string }): ProviderOutcome {
    const existing = this.records.get(input.orderId)
    if (existing) return existing.outcome
    const record: MockRecord = {
      outcome: MockProviderEngine.initialOutcome(input.orderId, input.key),
      queried: false,
      delivered: true
    }
    this.records.set(input.orderId, record)
    return record.outcome
  }

  query(orderId: string): ProviderOutcome {
    const record = this.records.get(orderId)
    if (!record) return { status: 'TIMEOUT' }
    if (record.outcome.status === 'TIMEOUT' && !record.queried) {
      // The provider accepted the money but the response was lost. The first
      // status query reveals the truth; later queries stay stable.
      record.queried = true
      record.outcome = { status: 'SUCCESS', providerRef: `MOCK-${orderId}` }
    }
    return record.outcome
  }

  // Test-visible counters. They are intentionally not exposed over HTTP.
  deliveredCount(): number {
    let count = 0
    for (const record of this.records.values()) if (record.delivered) count += 1
    return count
  }

  record(orderId: string): MockRecord | undefined {
    return this.records.get(orderId)
  }
}
