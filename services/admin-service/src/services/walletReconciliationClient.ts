import { env } from '../config/env'

// Single integration point for the wallet admin reconciliation API.
// W1-W4 are the contract agreed with the wallet owner (Khoa). On main only W1
// exists, and it does not return anomalies yet; W2-W4 are not implemented.
// Everything is therefore tested against a fake wallet HTTP server and must be
// reported as "not integrated with the real wallet" until Khoa confirms.

export type WalletAnomaly = {
  id: string
  reportId?: number
  type: string
  walletId?: number | null
  transactionId?: string | null
  detail?: unknown
}

export type WalletReconciliationReport = {
  id: number
  runAt?: string
  totalWallets?: number
  anomaliesFound?: number
  systemBalanceExpected?: string
  systemBalanceActual?: string
  isBalanced: boolean
  anomalies: WalletAnomaly[]
}

export type WalletReportPage = {
  items: WalletReconciliationReport[]
  page: number
  limit: number
  total: number
}

export type WalletAdjustResult = {
  transactionId: string | null
  replayed: boolean
}

export type WalletRequestContext = {
  gatewayToken: string
  requestId?: string
}

export type AdjustAnomalyRequest = {
  direction: 'CREDIT' | 'DEBIT'
  amount: string
  reason: string
  referenceId: string
}

export class WalletClientError extends Error {
  constructor(
    message: string,
    public readonly status: number | undefined,
    public readonly code: string | undefined,
    public readonly timedOut = false
  ) {
    super(message)
    this.name = 'WalletClientError'
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined

const asPositiveInt = (value: unknown): number | undefined => {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

const normalizeReport = (value: unknown): WalletReconciliationReport => {
  const record = asRecord(value)
  const id = asPositiveInt(record?.id)
  if (!record || id === undefined) {
    throw new WalletClientError('Wallet report is malformed', undefined, 'WALLET_BAD_RESPONSE')
  }
  const rawAnomalies = Array.isArray(record.anomalies) ? record.anomalies : []
  return {
    id,
    runAt: typeof record.runAt === 'string' ? record.runAt : undefined,
    totalWallets: typeof record.totalWallets === 'number' ? record.totalWallets : undefined,
    anomaliesFound:
      typeof record.anomaliesFound === 'number' ? record.anomaliesFound : rawAnomalies.length,
    systemBalanceExpected:
      typeof record.systemBalanceExpected === 'string' ? record.systemBalanceExpected : undefined,
    systemBalanceActual:
      typeof record.systemBalanceActual === 'string' ? record.systemBalanceActual : undefined,
    isBalanced: record.isBalanced === true,
    // Anomaly IDs are BigInt in wallet-service; JSON only carries them safely
    // as strings. Normalise here so the admin API never exposes a raw BigInt.
    anomalies: rawAnomalies.map(item => {
      const anomaly = asRecord(item) ?? {}
      return {
        id: String(anomaly.id ?? ''),
        reportId: typeof anomaly.reportId === 'number' ? anomaly.reportId : undefined,
        type: String(anomaly.type ?? 'UNKNOWN'),
        walletId: typeof anomaly.walletId === 'number' ? anomaly.walletId : null,
        transactionId: typeof anomaly.transactionId === 'string' ? anomaly.transactionId : null,
        detail: anomaly.detail
      }
    })
  }
}

export class WalletReconciliationClient {
  constructor(
    private readonly baseUrl: string = env.walletServiceUrl,
    private readonly timeoutMs = 60_000
  ) {}

  private async request(
    path: string,
    context: WalletRequestContext,
    init: { method: 'GET' | 'POST'; body?: unknown } = { method: 'GET' }
  ): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: {
          // Admin wallet routes accept only a Gateway token, never x-internal-key.
          'x-gateway-token': context.gatewayToken,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(context.requestId === undefined ? {} : { 'x-request-id': context.requestId })
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch (error) {
      const name = (error as { name?: string } | undefined)?.name
      const timedOut = name === 'TimeoutError' || name === 'AbortError'
      throw new WalletClientError(
        timedOut ? 'Wallet service did not respond in time' : 'Wallet service is unavailable',
        undefined,
        timedOut ? 'WALLET_TIMEOUT' : 'WALLET_UNAVAILABLE',
        timedOut
      )
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      payload = undefined
    }

    if (!response.ok) {
      const errorBody = asRecord(asRecord(payload)?.error)
      const code = typeof errorBody?.code === 'string' ? errorBody.code : undefined
      throw new WalletClientError(
        response.status === 401 || response.status === 403
          ? 'Wallet service denied the request'
          : 'Wallet service rejected the request',
        response.status,
        code
      )
    }

    const body = asRecord(payload)
    if (!body || body.success === false || body.data === undefined) {
      throw new WalletClientError('Wallet response is malformed', undefined, 'WALLET_BAD_RESPONSE')
    }
    return body.data
  }

  /** W1 */
  async run(isFull: boolean, context: WalletRequestContext): Promise<WalletReconciliationReport> {
    const data = await this.request(
      `/api/wallets/admin/reconciliation?isFull=${isFull ? 'true' : 'false'}`,
      context
    )
    return normalizeReport(data)
  }

  /** W2 */
  async listReports(page: number, limit: number, context: WalletRequestContext): Promise<WalletReportPage> {
    const data = asRecord(
      await this.request(
        `/api/wallets/admin/reconciliation/reports?page=${page}&limit=${limit}`,
        context
      )
    )
    if (!data || !Array.isArray(data.items)) {
      throw new WalletClientError('Wallet report list is malformed', undefined, 'WALLET_BAD_RESPONSE')
    }
    return {
      items: data.items.map(normalizeReport),
      page: asPositiveInt(data.page) ?? page,
      limit: asPositiveInt(data.limit) ?? limit,
      total: typeof data.total === 'number' ? data.total : 0
    }
  }

  /** W3 */
  async getReport(id: number, context: WalletRequestContext): Promise<WalletReconciliationReport> {
    return normalizeReport(
      await this.request(`/api/wallets/admin/reconciliation/reports/${id}`, context)
    )
  }

  /** W4 */
  async adjustAnomaly(
    anomalyId: string,
    body: AdjustAnomalyRequest,
    context: WalletRequestContext
  ): Promise<WalletAdjustResult> {
    const data = asRecord(
      await this.request(
        `/api/wallets/admin/reconciliation/anomalies/${encodeURIComponent(anomalyId)}/adjust`,
        context,
        { method: 'POST', body }
      )
    )
    return {
      transactionId: typeof data?.transactionId === 'string' ? data.transactionId : null,
      replayed: data?.replayed === true
    }
  }
}

let walletClient = new WalletReconciliationClient()

export function getWalletReconciliationClient(): WalletReconciliationClient {
  return walletClient
}

// Test seam: swap the HTTP client for one pointed at a fake wallet server.
export function setWalletReconciliationClient(client: WalletReconciliationClient): void {
  walletClient = client
}
