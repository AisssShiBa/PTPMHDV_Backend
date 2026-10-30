import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { hostReady } from './runtime.mjs'

function context(port) {
  return { base: 'http://127.0.0.1:' + port, brokerPort: port,
    config: { POSTGRES_HOST_PORT: String(port), S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:' + port } }
}

test('host readiness waits for HTTP readiness even with an accepting TCP listener', async t => {
  let ready = false, probes = 0
  const server = createServer((_request, response) => {
    probes++
    response.writeHead(ready ? 200 : 503).end()
    if (probes >= 2) ready = true
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  await hostReady(context(server.address().port), 3000)
  assert.ok(probes >= 4, 'Both HTTP endpoints must be retried after 503')
})

test('unreachable host ports fail explicitly before seed or DB migration', async () => {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  await assert.rejects(hostReady(context(port), 0), /Host port forwarding unavailable: Gateway, MinIO, PostgreSQL, RabbitMQ/)
})
