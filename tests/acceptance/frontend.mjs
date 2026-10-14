// Serve the real production bundle and forward every /api request to the real Gateway.
import { createServer, request } from 'node:http'
import { resolve, extname, sep } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { root } from './config.mjs'
const dist = resolve(root, '../PTPMHDV_Frontend/dist')
if (!existsSync(resolve(dist, 'index.html'))) throw new Error('Build frontend first')
createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  if (path.startsWith('/api/')) {
    const upstream = request({ hostname: '127.0.0.1', port: 3000, path: req.url, method: req.method,
      headers: { ...req.headers, host: 'localhost:3000' } }, (reply) => {
      res.writeHead(reply.statusCode, reply.headers)
      reply.pipe(res)
    })
    upstream.on('error', () => { res.writeHead(502); res.end('Gateway unavailable') })
    req.pipe(upstream)
    return
  }
  const file = resolve(dist, '.' + decodeURIComponent(path))
  if (file !== dist && !file.startsWith(dist + sep)) { res.writeHead(403); res.end(); return }
  const target = extname(path) && existsSync(file) ? file : resolve(dist, 'index.html')
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }
  res.writeHead(200, { 'Content-Type': mime[extname(target)] || 'application/octet-stream' })
  res.end(readFileSync(target))
}).listen(5173, '127.0.0.1', () => console.log('Real frontend: http://localhost:5173; /api -> Gateway 3000'))
