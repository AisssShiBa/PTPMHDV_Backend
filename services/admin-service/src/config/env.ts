import dotenv from 'dotenv'
import { loadSecretEnvironment } from 'finvault-internal-auth'
dotenv.config()
loadSecretEnvironment(['INTERNAL_KEY'])

const internalKey = (process.env.INTERNAL_KEY || '').trim()
if (!internalKey) {
  throw new Error('Thiếu biến môi trường bắt buộc: INTERNAL_KEY')
}

export const env = {
  port: parseInt(process.env.PORT || '3007', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/admin_service',
  internalKey,
  userServiceUrl: process.env.USER_SERVICE_URL || 'http://localhost:3002',
  merchantServiceUrl: process.env.MERCHANT_SERVICE_URL || 'http://localhost:3003',
  walletServiceUrl: process.env.WALLET_SERVICE_URL || 'http://localhost:3004',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173'
}
