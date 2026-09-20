import 'dotenv/config'

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
  // CLIENT_URL — optional: thiếu thì fallback về origin dev cục bộ
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  databaseUrl: required('DATABASE_URL')
}
