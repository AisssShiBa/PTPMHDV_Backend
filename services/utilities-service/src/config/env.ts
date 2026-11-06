import 'dotenv/config'
import { getGatewayPublicKey, loadSecretEnvironment } from 'finvault-internal-auth'
import { z } from 'zod'

loadSecretEnvironment(['INTERNAL_KEY'])

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3008),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  INTERNAL_KEY: z.string().min(32),
  CLIENT_URL: z.string().url().default('http://localhost:5173'),
  RABBITMQ_URL: z.string().url().optional(),
  PAYMENT_SERVICE_URL: z.string().url().default('http://localhost:3005'),
  MOCK_PROVIDER_ENABLED: z.enum(['true', 'false']).default('false'),
  PROVIDER_BASE_URL: z.string().url().optional(),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(10000),
  RECOVERY_ENABLED: z.enum(['true', 'false']).default('true'),
  RECOVERY_INTERVAL_MS: z.coerce.number().int().min(1000).max(3600000).default(30000),
  RECOVERY_STALE_MS: z.coerce.number().int().min(1000).max(86400000).default(60000)
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  throw new Error(
    'Invalid environment: ' + parsed.error.issues.map(issue => issue.path.join('.')).join(', ')
  )
}
getGatewayPublicKey()
const config = parsed.data

export const env = {
  port: config.PORT,
  nodeEnv: config.NODE_ENV,
  isProduction: config.NODE_ENV === 'production',
  databaseUrl: config.DATABASE_URL,
  internalKey: config.INTERNAL_KEY,
  clientUrl: config.CLIENT_URL,
  rabbitmqUrl: config.RABBITMQ_URL,
  paymentServiceUrl: config.PAYMENT_SERVICE_URL,
  mockProviderEnabled: config.MOCK_PROVIDER_ENABLED === 'true',
  providerBaseUrl: config.PROVIDER_BASE_URL ?? `http://127.0.0.1:${config.PORT}`,
  providerTimeoutMs: config.PROVIDER_TIMEOUT_MS,
  recoveryEnabled: config.RECOVERY_ENABLED === 'true',
  recoveryIntervalMs: config.RECOVERY_INTERVAL_MS,
  recoveryStaleMs: config.RECOVERY_STALE_MS
}
