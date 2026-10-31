import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createServer, createConnection } from 'node:net'
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

export const root = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(import.meta.url)
const { initialize } = require('../../../scripts/init-secrets.js')
export const uuid = randomUUID
export const pause = delay

async function freePort() {
  const server = createServer()
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok) })
  const port = server.address().port
  await new Promise(ok => server.close(ok))
  return port
}
export async function prepare() {
  const project = 'finvault-acceptance-' + randomUUID().replaceAll('-', '').slice(0, 12)
  const directory = resolve(root, '.cache/acceptance-week2', project)
  mkdirSync(directory, { recursive: true })
  copyFileSync(resolve(root, '.env.example'), resolve(directory, '.env.example'))
  copyFileSync(resolve(root, 'init-db.sql'), resolve(directory, 'init-db.sql'))
  initialize(directory)
  const config = parseEnv(readFileSync(resolve(directory, '.env'), 'utf8'))
  const ports = new Set()
  async function port() { let p; do { p = await freePort() } while (ports.has(p)); ports.add(p); return p }
  config.GATEWAY_PORT = String(await port())
  config.POSTGRES_HOST_PORT = String(await port())
  config.MINIO_HOST_PORT = String(await port())
  config.S3_PUBLIC_ENDPOINT = 'http://127.0.0.1:' + config.MINIO_HOST_PORT
  config.KYC_URL_TTL_SECONDS = '2'
  const brokerPort = await port()
  // Persist the actual run's ports as well as its secrets. A later diagnostic
  // compose command must target the same endpoints, not .env.example defaults.
  const envPath = resolve(directory, '.env')
  writeFileSync(envPath, readFileSync(envPath, 'utf8') + '\n' +
    ['GATEWAY_PORT', 'POSTGRES_HOST_PORT', 'MINIO_HOST_PORT', 'S3_PUBLIC_ENDPOINT', 'KYC_URL_TTL_SECONDS']
      .map(key => key + '=' + config[key]).join('\n') + '\n', { mode: 0o600 })
  // Every run gets a new project, credentials, ports and volumes. No down -v.
  const secrets = Object.fromEntries(Object.entries({
    internal_key: 'internal_key.txt', access_token_secret: 'access_token_secret.txt',
    postgres_password: 'postgres_password.txt', rabbitmq_pass: 'rabbitmq_pass.txt',
    gateway_private_key: 'gateway_private.pem', gateway_public_key: 'gateway_public.pem',
    vnp_hash_secret: 'vnp_hash_secret.txt',
    auth_txn_private_key: 'auth_txn_private.pem', auth_txn_public_key: 'auth_txn_public.pem'
  }).map(([name, file]) => [name, { file: resolve(directory, 'secrets', file) }]))
  const override = {
    services: {
      postgres: { volumes: [resolve(directory, 'secrets/init-db.sql').replaceAll('\\', '/') + ':/docker-entrypoint-initdb.d/init-db.sql:ro'] },
      rabbitmq: { ports: ['127.0.0.1:' + brokerPort + ':5672'],
        healthcheck: { start_period: '120s', timeout: '20s', retries: 20 } }
    }, secrets
  }
  writeFileSync(resolve(directory, 'compose.json'), JSON.stringify(override, null, 2))
  const testConfig = {
    purpose: 'finvault-week2-isolated-regression',
    databaseUrl: 'postgresql://postgres:' + config.POSTGRES_PASSWORD_URLENCODED + '@127.0.0.1:' + config.POSTGRES_HOST_PORT + '/finvault_test',
    rabbitmqUrl: 'amqp://' + encodeURIComponent(config.RABBITMQ_USER) + ':' + encodeURIComponent(config.RABBITMQ_PASS) + '@127.0.0.1:' + brokerPort + '/acceptance-regression',
    storageEndpoint: config.S3_PUBLIC_ENDPOINT,
    storageAccessKey: config.MINIO_ROOT_USER, storageSecretKey: config.MINIO_ROOT_PASSWORD,
    internalKey: config.INTERNAL_KEY
  }
  writeFileSync(resolve(directory, 'regression.json'), JSON.stringify(testConfig), { mode: 0o600 })
  const env = { ...process.env, ...config, COMPOSE_PROJECT_NAME: project, COMPOSE_PARALLEL_LIMIT: '2' }
  // Child services must only read the secrets belonging to this run.
  for (const key of ['INTERNAL_KEY_FILE', 'ACCESS_TOKEN_SECRET_FILE', 'DATABASE_URL', 'COMPOSE_FILE']) delete env[key]
  const composeArgs = ['compose', '--project-directory', root, '--env-file', resolve(directory, '.env'),
    '-p', project, '-f', resolve(root, 'docker-compose.yml'), '-f', resolve(directory, 'compose.json')]
  const ctx = { project, directory, config, env, composeArgs, brokerPort, requests: [],
    base: 'http://127.0.0.1:' + config.GATEWAY_PORT }
  writeFileSync(resolve(directory, 'run.json'), JSON.stringify({ project, gateway: ctx.base, createdAt: new Date().toISOString() }, null, 2))
  return ctx
}

function tcpReady(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(port) })
    const finish = ready => { socket.destroy(); resolve(ready) }
    socket.setTimeout(1500)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

export async function hostReady(ctx, timeout = 90000) {
  // Compose healthchecks execute inside containers. Docker Desktop's host
  // forwarding can still be unavailable when those healthchecks turn green.
  const endpoints = [
    ['Gateway', () => fetch(ctx.base + '/health', { signal: AbortSignal.timeout(1500) }).then(r => r.ok)],
    ['MinIO', () => fetch(ctx.config.S3_PUBLIC_ENDPOINT + '/minio/health/live', { signal: AbortSignal.timeout(1500) }).then(r => r.ok)],
    ['PostgreSQL', () => tcpReady(ctx.config.POSTGRES_HOST_PORT)],
    ['RabbitMQ', () => tcpReady(ctx.brokerPort)]
  ]
  const deadline = Date.now() + timeout
  let unavailable
  do {
    const ready = await Promise.all(endpoints.map(async ([name, probe]) =>
      await probe().catch(() => false) ? null : name))
    unavailable = ready.filter(Boolean)
    if (!unavailable.length) return
    await delay(500)
  } while (Date.now() < deadline)
  assert.fail('Host port forwarding unavailable: ' + unavailable.join(', ') +
    '; inspect Docker Desktop port mappings (container health alone is insufficient)')
}
export function docker(ctx, ...args) {
  return execFileSync('docker', [...ctx.composeArgs, ...args], {
    cwd: root, env: ctx.env, encoding: 'utf8', windowsHide: true, timeout: 30000,
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}
export async function command(ctx, name, executable, args, options = {}) {
  const log = openSync(resolve(ctx.directory, name + '.log'), 'w')
  try {
    const code = await new Promise((ok, fail) => {
      const child = spawn(executable, args, { cwd: root, env: ctx.env, windowsHide: true,
        stdio: ['ignore', log, log], ...options })
      child.once('error', fail)
      child.once('exit', (code) => ok(code ?? 1))
    })
    assert.equal(code, 0, name + ' failed; inspect ' + name + '.log in the run directory')
  } finally { closeSync(log) }
}
export function sql(ctx, database, statement) {
  assert.ok(['auth_service', 'user_service', 'merchant_service', 'wallet_service', 'payment_service', 'notification_service', 'admin_service', 'postgres'].includes(database))
  return docker(ctx, 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', database,
    '-At', '-v', 'ON_ERROR_STOP=1', '-c', statement)
}
export async function call(ctx, path, { method = 'GET', body, token, cookie, headers = {}, expected = 200 } = {}) {
  // Respect the real Gateway IP rate limit during a long full-system run.
  ctx.requestTimes ??= []
  ctx.requestTimes = ctx.requestTimes.filter(time => Date.now() - time < 61000)
  if (ctx.requestTimes.length >= 100) await delay(Math.max(0, ctx.requestTimes[0] + 61000 - Date.now()))
  ctx.requestTimes = ctx.requestTimes.filter(time => Date.now() - time < 61000)
  ctx.requestTimes.push(Date.now())
  const form = body instanceof FormData
  const response = await fetch(ctx.base + '/api' + path, {
    method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(cookie ? { cookie } : {}), ...(body && !form ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? (form ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(15000)
  })
  const value = await response.json().catch(() => ({}))
  ctx.requests.push({ method, path: path.split('?')[0], status: response.status, code: value.error?.code })
  if (expected !== null) assert.equal(response.status, expected, method + ' ' + path.split('?')[0] + ': unexpected status (' + (value.error?.code || 'no code') + ')')
  return { ...value, httpStatus: response.status, cookie: response.headers.get('set-cookie'), headers: response.headers }
}
export async function until(check, message, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await delay(200) }
  throw new Error(message)
}
export function broker(ctx, code) {
  return docker(ctx, 'exec', '-T', 'user-publisher', 'node', '-e',
    "const amqp=require('amqplib');(async()=>{const c=await amqp.connect(process.env.RABBITMQ_URL);try{const ch=await c.createConfirmChannel();" +
    code + "}finally{await c.close()}})().catch(()=>process.exit(1))")
}
export async function documents(two = true) {
  const userRequire = createRequire(resolve(root, 'services/user-service/package.json'))
  const png = await userRequire('sharp')({ create: { width: 32, height: 20, channels: 3, background: '#ddd' } }).png().toBuffer()
  const form = new FormData()
  form.set('idNumber', '000000001234')
  form.set('front', new Blob([png], { type: 'image/png' }), 'synthetic-front.png')
  if (two) form.set('back', new Blob([png], { type: 'image/png' }), 'synthetic-back.png')
  return form
}
export async function account(ctx, label, email = label + '-' + uuid() + '@example.test', role = 'USER') {
  const record = { username: 'accept_' + label + '_' + uuid().replaceAll('-', '').slice(0, 12),
    email, password: 'Synthetic-' + uuid(), firstName: 'Acceptance', lastName: label }
  const signup = await call(ctx, '/auth/signup', { method: 'POST', body: record, expected: 201 })
  record.id = signup.data.userId
  assert.match(record.id, /^[0-9a-f-]{36}$/)
  if (role === 'ADMIN') sql(ctx, 'auth_service', 'UPDATE "User" SET role=\'ADMIN\' WHERE id=\'' + record.id + '\'')
  const login = await call(ctx, '/auth/signin', { method: 'POST', body: record })
  record.token = login.data.accessToken
  await until(async () => {
    const profile = await call(ctx, '/users/me', { token: record.token, expected: null })
    if (profile.httpStatus === 200) record.profileId = profile.data.id
    return Boolean(record.profileId)
  }, 'Signup profile provisioning timed out')
  await until(async () => (await call(ctx, '/wallets/' + record.id + '/balance',
    { token: record.token, expected: null })).httpStatus === 200, 'Signup wallet provisioning timed out')
  return record
}

