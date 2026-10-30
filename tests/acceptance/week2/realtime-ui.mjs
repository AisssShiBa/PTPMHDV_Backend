import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, extname, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root, pause, account, call, uuid } from './runtime.mjs'
import { checkout, tokenFor, confirm } from './p2p-scenarios.mjs'

// The real production frontend, real login and real Payment/PIN flow. No mocked
// API, injected session, fabricated socket event or synthetic toast is used.
export async function realtimeUI(ctx, accounts) {
  const frontend = resolve(process.env.FINVAULT_FRONTEND_DIR || resolve(root, '../PTPMHDV_Frontend'))
  const dist = resolve(frontend, 'dist')
  assert.ok(existsSync(resolve(dist, 'index.html')), 'Build the frontend before R1-UI (FINVAULT_FRONTEND_DIR selects its checkout)')
  const { openBrowser, until } = await import(pathToFileURL(resolve(frontend, 'tests/browser-support.mjs')).href)
  const gateway = new URL(ctx.base)
  const sockets = new Set()
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path.startsWith('/api/') || path.startsWith('/socket.io')) {
      const upstream = request(new URL(req.url, gateway), { method: req.method,
        headers: { ...req.headers, host: gateway.host } }, reply => {
        res.writeHead(reply.statusCode, reply.headers); reply.pipe(res)
      })
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
      req.pipe(upstream)
      return
    }
    const candidate = resolve(dist, '.' + decodeURIComponent(path))
    if (!candidate.startsWith(dist + sep) && candidate !== dist) { res.writeHead(403).end(); return }
    const file = extname(path) && existsSync(candidate) ? candidate : resolve(dist, 'index.html')
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/socket.io')) { socket.destroy(); return }
    const upstream = request(new URL(req.url, gateway), { headers: { ...req.headers, host: gateway.host } })
    upstream.on('upgrade', (reply, target, targetHead) => {
      sockets.add(target); target.once('close', () => sockets.delete(target))
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
        Object.entries(reply.headers).map(([key, value]) => key + ': ' + value).join('\r\n') + '\r\n\r\n')
      if (head.length) target.write(head)
      if (targetHead.length) socket.write(targetHead)
      socket.pipe(target).pipe(socket)
      socket.on('error', () => target.destroy()); target.on('error', () => socket.destroy())
    })
    upstream.on('error', () => socket.destroy())
    upstream.end()
  })
  let browser
  try {
    const recent = (ctx.requestTimes || []).filter(time => Date.now() - time < 61000)
    if (recent.length > 50) await pause(Math.max(0, recent[0] + 61000 - Date.now()))
    // Each test owns its sender/PIN budget; earlier token tests must not consume
    // the ten legitimate verifications measured here. Fund via the real ledger.
    const sender = await account(ctx, 'r1-ui-sender')
    const receiver = await account(ctx, 'r1-ui-recipient')
    await call(ctx, '/wallets/' + sender.id + '/credit', { method: 'POST', token: accounts.admin.token,
      body: { amount: '500000', referenceId: uuid(), transferType: 'TOPUP' } })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    browser = await openBrowser(ctx.directory, 'r1-ui', 'http://localhost:' + server.address().port)
    let connected = false
    browser.on('Network.webSocketFrameReceived', ({ response }) => {
      if (response.payloadData.startsWith('40')) connected = true
    })
    browser.on('Network.responseReceived', async ({ response, requestId }) => {
      if (!response.url.includes('/socket.io/') || response.status !== 200) return
      // A Socket.IO CONNECT acknowledgement can arrive over polling before the
      // browser upgrades to WebSocket. Read only the server response, never auth.
      try {
        const { body } = await browser.cdp('Network.getResponseBody', { requestId })
        if (body.split('\x1e').some(packet => packet.startsWith('40'))) connected = true
      } catch { /* The body may still be streaming; subsequent packets also count. */ }
    })
    await browser.go('/signin')
    await until(() => browser.has('#username'), 'R1 signin form')
    await browser.fill('#username', receiver.username)
    await browser.fill('#password', receiver.password)
    await browser.evaluate('document.querySelector("form").requestSubmit()')
    await until(() => browser.evaluate('location.pathname !== "/signin"'), 'R1 real login')
    await until(() => connected, 'R1 authenticated browser socket', 20000)
    assert.ok(browser.network.some(row => row.path === '/api/notifications/socket-ticket' && row.status === 200))
    await browser.evaluate(`(() => {
      window.__r1Toasts = [];
      const seen = new WeakSet();
      new MutationObserver(() => {
        document.querySelectorAll('[data-sonner-toast][data-mounted="true"]').forEach(node => {
          if (seen.has(node) || node.dataset.removed === 'true' || !node.innerText.includes('Bạn nhận')) return;
          if (!node.getBoundingClientRect().height || getComputedStyle(node).visibility === 'hidden') return;
          seen.add(node); window.__r1Toasts.push({ at: Date.now(), text: node.innerText });
        });
      }).observe(document.body, { childList: true, subtree: true, attributes: true });
    })()`)
    const times = []
    for (let i = 0; i < 10; i++) {
      const payment = (await checkout(ctx, sender, receiver, '50000')).data
      const token = await tokenFor(ctx, sender, payment)
      const start = Date.now()
      assert.equal((await confirm(ctx, sender, payment, token)).data.status, 'SUCCESS')
      await until(() => browser.evaluate('window.__r1Toasts.length > ' + i), 'R1 visible recipient toast', 15000)
      times.push((await browser.evaluate('window.__r1Toasts[' + i + '].at')) - start)
    }
    const good = times.filter(ms => ms >= 0 && ms <= 3000).length
    await browser.screenshot('r1-recipient-popup')
    writeFileSync(resolve(ctx.directory, 'r1-ui.json'), JSON.stringify({ good, attempts: 10, times,
      authenticatedSocket: connected, runtimeErrors: browser.errors }, null, 2))
    assert.equal(browser.errors.length, 0, 'Browser runtime exceptions during R1')
    assert.ok(good >= 9, 'R1-UI: only ' + good + '/10 visible popups within 3 seconds')
  } finally {
    await browser?.close()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}
