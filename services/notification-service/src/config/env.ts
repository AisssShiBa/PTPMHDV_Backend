import 'dotenv/config'
import { loadSecretEnvironment } from 'finvault-internal-auth'
loadSecretEnvironment(['INTERNAL_KEY', 'ACCESS_TOKEN_SECRET'])

const defaultSocketMaxAgeMs = 14 * 60 * 1000
const configuredSocketMaxAgeMs = Number.parseInt(process.env.SOCKET_MAX_AGE_MS ?? '', 10)

function required(key: string): string {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Thiếu biến môi trường bắt buộc: ${key}`)
  }
  return value
}

export const env = {
  port: parseInt(process.env.PORT ?? '3006', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  // INTERNAL_KEY — ĐỒNG BỘ với Gateway + Payment + Wallet (header: x-internal-key)
  internalKey: required('INTERNAL_KEY'),
  rabbitmqUrl: process.env.RABBITMQ_URL,
  rabbitmqQueue: process.env.RABBITMQ_QUEUE || 'notification-service',
  socketMaxAgeMs:
    Number.isFinite(configuredSocketMaxAgeMs) && configuredSocketMaxAgeMs > 0
      ? configuredSocketMaxAgeMs
      : defaultSocketMaxAgeMs,
  // CLIENT_URL — optional: thiếu thì fallback về origin dev cục bộ
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  databaseUrl: required('DATABASE_URL'),
  userLookupUrl: process.env.USER_LOOKUP_URL
}
