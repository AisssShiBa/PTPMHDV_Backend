import 'dotenv/config'

export const env = {
  port: Number(process.env.PORT ?? 4004),
  databaseUrl: process.env.DATABASE_URL,
  internalApiKey: process.env.INTERNAL_KEY || process.env.INTERNAL_API_KEY,
  nodeEnv: process.env.NODE_ENV ?? 'development',
  userServiceUrl: process.env.USER_SERVICE_URL,
  holdSweepIntervalMs: Number(process.env.HOLD_SWEEP_INTERVAL_MS ?? 60_000)
}

if (!Number.isInteger(env.port) || env.port < 0 || env.port > 65535) {
  throw new Error('PORT must be a valid TCP port')
}

if (!Number.isInteger(env.holdSweepIntervalMs) || env.holdSweepIntervalMs < 10_000) {
  throw new Error('HOLD_SWEEP_INTERVAL_MS must be an integer of at least 10000')
}

if (env.nodeEnv === 'production' && !env.databaseUrl) {
  throw new Error('DATABASE_URL is required in production')
}
