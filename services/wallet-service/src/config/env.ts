import 'dotenv/config'

export const env = {
  port: Number(process.env.PORT ?? 4004),
  databaseUrl: process.env.DATABASE_URL,
  internalApiKey: process.env.INTERNAL_API_KEY,
  nodeEnv: process.env.NODE_ENV ?? 'development'
}

if (!Number.isInteger(env.port) || env.port < 0 || env.port > 65535) {
  throw new Error('PORT must be a valid TCP port')
}
