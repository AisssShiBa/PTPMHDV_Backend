type LookupLog = (code: string, userId: string) => void
type FetchLike = typeof fetch

export interface UserLookupOptions {
  baseUrl?: string
  internalKey: string
  timeoutMs?: number
  cacheTtlMs?: number
  maxCacheEntries?: number
  fetchImpl?: FetchLike
  logFailure?: LookupLog
}

export interface UserLookupClient {
  getFullName(userId: string): Promise<string | null>
}

export function shortenDisplayName(fullName: string | null | undefined): string {
  const parts = fullName?.trim().split(/\s+/).filter(Boolean) ?? []
  if (parts.length < 2) return 'một người dùng'
  return `${parts[0]} ${Array.from(parts[parts.length - 1])[0]}.`
}

export function createUserLookupClient(options: UserLookupOptions): UserLookupClient {
  const timeoutMs = options.timeoutMs ?? 1500
  const cacheTtlMs = options.cacheTtlMs ?? 60_000
  const maxCacheEntries = options.maxCacheEntries ?? 1000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isInteger(cacheTtlMs) || cacheTtlMs < 1 ||
      !Number.isInteger(maxCacheEntries) || maxCacheEntries < 1) {
    throw new TypeError('User lookup timeout, cache TTL, and cache size must be positive integers')
  }

  const fetchImpl = options.fetchImpl ?? fetch
  const cache = new Map<string, { fullName: string | null; expiresAt: number }>()
  const pending = new Map<string, Promise<string | null>>()

  const remember = (userId: string, fullName: string | null): void => {
    cache.delete(userId)
    while (cache.size >= maxCacheEntries) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    cache.set(userId, { fullName, expiresAt: Date.now() + cacheTtlMs })
  }

  const lookup = async (userId: string): Promise<string | null> => {
    if (!options.baseUrl) return null

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const endpoint = new URL(encodeURIComponent(userId), options.baseUrl.endsWith('/')
        ? options.baseUrl
        : `${options.baseUrl}/`)
      const response = await fetchImpl(endpoint, {
        method: 'GET',
        headers: { 'x-internal-key': options.internalKey },
        signal: controller.signal
      })
      if (!response.ok) {
        options.logFailure?.(`http_${response.status}`, userId)
        return null
      }

      const body: unknown = await response.json()
      if (typeof body !== 'object' || body === null || !('data' in body) ||
          typeof body.data !== 'object' || body.data === null ||
          !('fullName' in body.data) ||
          (body.data.fullName !== null && typeof body.data.fullName !== 'string')) {
        options.logFailure?.('invalid_response', userId)
        return null
      }
      const fullName = typeof body.data.fullName === 'string' && body.data.fullName.trim()
        ? body.data.fullName.trim()
        : null
      return fullName
    } catch (error) {
      options.logFailure?.(
        controller.signal.aborted ? 'timeout' : 'request_failed',
        userId
      )
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async getFullName(userId: string): Promise<string | null> {
      const cached = cache.get(userId)
      if (cached && cached.expiresAt > Date.now()) return cached.fullName
      if (cached) cache.delete(userId)

      const inProgress = pending.get(userId)
      if (inProgress) return inProgress

      const request = lookup(userId)
        .then(fullName => {
          if (options.baseUrl) remember(userId, fullName)
          return fullName
        })
        .finally(() => pending.delete(userId))
      pending.set(userId, request)
      return request
    }
  }
}
