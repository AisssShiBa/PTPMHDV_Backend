import 'dotenv/config'
import { getGatewayPublicKey, loadSecretEnvironment } from 'finvault-internal-auth'

loadSecretEnvironment(['INTERNAL_KEY', 'ACCESS_TOKEN_SECRET'])

function required(key: string): string {
  const value = process.env[key]
  if (!value || !value.trim()) {
    throw new Error(`Thiếu biến môi trường bắt buộc: ${key}`)
  }
  return value.trim()
}

// Bắt buộc xác thực khóa công khai của Gateway ngay khi khởi động
getGatewayPublicKey()

const internalKey = (process.env.INTERNAL_KEY || process.env.INTERNAL_API_KEY || '').trim()
if (!internalKey) {
  throw new Error('Thiếu biến môi trường bắt buộc: INTERNAL_KEY')
}

export const env = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  databaseUrl: required('DATABASE_URL'),
  accessTokenSecret: required('ACCESS_TOKEN_SECRET'),
  userServiceUrl: process.env.USER_SERVICE_URL || 'http://localhost:3002',
  walletServiceUrl: process.env.WALLET_SERVICE_URL || 'http://localhost:3004',
  internalApiKey: internalKey,
  internalKey,
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173'
}
