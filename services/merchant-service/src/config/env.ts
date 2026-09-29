import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3003),
  DATABASE_URL: z.string().min(1),
  INTERNAL_KEY: z.string().min(32),
  ACCESS_TOKEN_SECRET: z.string().min(32),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CLIENT_URL: z.string().url().default('http://localhost:5173'),
  DISABLE_GATEWAY_CHECK: z.enum(['true', 'false']).default('false'),
  RABBITMQ_URL: z.string().url().optional(),
  EVENT_EXCHANGE: z.string().min(1).default('finvault.events'),
  EVENT_MAX_RETRIES: z.coerce.number().int().min(1).max(10).default(5),
  EVENT_RETRY_MS: z.coerce.number().int().min(100).max(60000).default(2000),
  OUTBOX_POLL_MS: z.coerce.number().int().min(100).default(1000),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('true')
})
const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  throw new Error('Invalid environment: ' + parsed.error.issues.map(issue => issue.path.join('.')).join(', '))
}
const config = parsed.data
export const env = {
  port: config.PORT, databaseUrl: config.DATABASE_URL,
  internalKey: config.INTERNAL_KEY, accessTokenSecret: config.ACCESS_TOKEN_SECRET,
  nodeEnv: config.NODE_ENV, clientUrl: config.CLIENT_URL,
  disableGatewayCheck: config.NODE_ENV !== 'production' && config.DISABLE_GATEWAY_CHECK === 'true',
  rabbitmqUrl: config.RABBITMQ_URL, eventExchange: config.EVENT_EXCHANGE,
  eventMaxRetries: config.EVENT_MAX_RETRIES, eventRetryMs: config.EVENT_RETRY_MS,
  outboxPollMs: config.OUTBOX_POLL_MS,
  s3: { endpoint: config.S3_ENDPOINT, region: config.S3_REGION, bucket: config.S3_BUCKET,
    accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    forcePathStyle: config.S3_FORCE_PATH_STYLE === 'true' }
}
