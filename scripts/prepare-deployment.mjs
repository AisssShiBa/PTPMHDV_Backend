import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdirSync, existsSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = resolve(root, '.cache/deployment')
mkdirSync(resolve(directory, 'keys'), { recursive: true })
const privatePath = resolve(directory, 'keys/gateway-private.pem')
const publicPath = resolve(directory, 'keys/gateway-public.pem')
if (existsSync(privatePath) !== existsSync(publicPath)) throw new Error('Incomplete key pair; inspect existing deployment keys')
if (!existsSync(privatePath)) {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  writeFileSync(privatePath, keys.privateKey, { mode: 0o600, flag: 'wx' })
  writeFileSync(publicPath, keys.publicKey, { flag: 'wx' })
}
const env = resolve(directory, 'runtime.env')
if (!existsSync(env)) {
  const secret = () => randomBytes(32).toString('hex')
  writeFileSync(env, [
    'INTERNAL_KEY=' + secret(), 'ACCESS_TOKEN_SECRET=' + secret(),
    'RABBITMQ_USER=finvault', 'RABBITMQ_PASS=' + secret(),
    'MINIO_ROOT_USER=finvault-admin', 'MINIO_ROOT_PASSWORD=' + secret(),
    'S3_ACCESS_KEY_ID=finvault-kyc', 'S3_SECRET_ACCESS_KEY=' + secret(),
    'S3_BUCKET=finvault-kyc', 'S3_PUBLIC_ENDPOINT=http://localhost:19002'
  ].join('\n') + '\n', { mode: 0o600, flag: 'wx' })
}
const config = parseEnv(readFileSync(env, 'utf8'))
if (!config.RABBITMQ_URL) appendFileSync(env, '\nRABBITMQ_URL=amqp://' +
  encodeURIComponent(config.RABBITMQ_USER) + ':' + encodeURIComponent(config.RABBITMQ_PASS) + '@rabbitmq:5672\n')
console.log('Isolated runtime-test configuration ready in .cache/deployment; existing credentials preserved. Main Quick Start uses node scripts/init-secrets.js.')
