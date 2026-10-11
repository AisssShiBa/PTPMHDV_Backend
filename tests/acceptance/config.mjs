import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

export const root = fileURLToPath(new URL('../../', import.meta.url))
export const runtime = resolve(root, '.cache/acceptance')
export function config() { return JSON.parse(readFileSync(resolve(runtime, 'config.json'), 'utf8')) }
export const services = ['user', 'merchant', 'wallet', 'auth', 'admin']
export const ports = { gateway: 3000, auth: 3001, user: 3002, merchant: 3003, wallet: 3004, admin: 3007 }
export function serviceDir(name) { return name === 'gateway' ? resolve(root, 'gateway') : resolve(root, 'services', name + '-service') }
export function serviceEnv(name) {
  const value = config()
  return {
    ...process.env,
    NODE_ENV: 'development', PORT: String(ports[name]),
    DATABASE_URL: 'postgresql://acceptance:' + value.dbPassword + '@127.0.0.1:25433/finvault_acceptance?schema=' + name,
    ...(name === 'user' || name === 'merchant' ? { ACCESS_TOKEN_SECRET: '' } : { ACCESS_TOKEN_SECRET: value.jwtSecret }),
    GATEWAY_PUBLIC_KEY_FILE: resolve(runtime, 'gateway-public.pem'),
    ...(name === 'gateway' ? { GATEWAY_PRIVATE_KEY_FILE: resolve(runtime, 'gateway-private.pem') } : {}), INTERNAL_KEY: value.internalKey,
    CLIENT_URL: 'http://localhost:5173',
    AUTH_SERVICE_URL: 'http://127.0.0.1:3001', USER_SERVICE_URL: 'http://127.0.0.1:3002',
    MERCHANT_SERVICE_URL: 'http://127.0.0.1:3003', ADMIN_SERVICE_URL: 'http://127.0.0.1:3007',
    WALLET_SERVICE_URL: 'http://127.0.0.1:3004',
    S3_ENDPOINT: 'http://localhost:19001', S3_REGION: 'us-east-1',
    S3_BUCKET: 'finvault-acceptance-kyc', S3_ACCESS_KEY_ID: 'acceptance',
    S3_SECRET_ACCESS_KEY: value.storagePassword, S3_FORCE_PATH_STYLE: 'true',
    RABBITMQ_URL: 'amqp://127.0.0.1:5673'
  }
}
