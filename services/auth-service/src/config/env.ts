import 'dotenv/config'

function required(key: string): string {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Thiếu biến môi trường bắt buộc: ${key}`)
  }
  return value
}

export const env = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  databaseUrl: required('DATABASE_URL'),
  accessTokenSecret: process.env.ACCESS_TOKEN_SECRET || 'd7aec1b51b32d434b4c2e29f6b7e12ad0ea34f68ad9203c91f244d95f87adeb7dc6bc157976ffeedc6b1b5a109fc01d7c419d69bcf59d873e65e4409f88f9f64',
  userServiceUrl: process.env.USER_SERVICE_URL || 'http://localhost:3002',
  walletServiceUrl: process.env.WALLET_SERVICE_URL || 'http://localhost:3004',
  internalApiKey: process.env.INTERNAL_API_KEY || process.env.INTERNAL_KEY || '6mliy6JhxAbD6Rtu5EtNt81zi2nHcx42',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  disableGatewayCheck: process.env.DISABLE_GATEWAY_CHECK === 'true'
}
