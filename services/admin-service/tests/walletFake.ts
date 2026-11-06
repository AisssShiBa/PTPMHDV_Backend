import http from 'node:http'
import type { AddressInfo } from 'node:net'

export type FakeWalletRequest = {
  method: string
  path: string
  query: URLSearchParams
  headers: http.IncomingHttpHeaders
  body: any
}

export type FakeWalletReply = { status: number; body: unknown }

export type FakeWalletHandler = (
  request: FakeWalletRequest
) => FakeWalletReply | Promise<FakeWalletReply>

export type FakeWallet = {
  url: string
  requests: FakeWalletRequest[]
  setHandler(handler: FakeWalletHandler): void
  close(): Promise<void>
}

export const walletOk = (data: unknown): FakeWalletReply => ({
  status: 200,
  body: { success: true, data }
})

export const walletError = (status: number, code: string): FakeWalletReply => ({
  status,
  body: { success: false, error: { code, message: 'fake wallet error' } }
})

export async function startFakeWallet(initial: FakeWalletHandler): Promise<FakeWallet> {
  const requests: FakeWalletRequest[] = []
  let handler = initial

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const raw = Buffer.concat(chunks).toString('utf8')
      const request: FakeWalletRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body: raw.length === 0 ? undefined : JSON.parse(raw)
      }
      requests.push(request)
      try {
        const reply = await handler(request)
        res.writeHead(reply.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(reply.body))
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: { code: 'FAKE_WALLET_FAILURE' } }))
      }
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setHandler(next: FakeWalletHandler) {
      handler = next
    },
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve())
        // fetch/undici keeps sockets alive; don't let them block test shutdown.
        server.closeAllConnections?.()
      })
  }
}
