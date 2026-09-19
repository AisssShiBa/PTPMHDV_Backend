import dotenv from 'dotenv'
dotenv.config()

export const env = {
  port: parseInt(process.env.PORT || '3007', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/admin_service',
  internalKey: process.env.INTERNAL_KEY || '6mliy6JhxAbD6Rtu5EtNt81zi2nHcx42',
  userServiceUrl: process.env.USER_SERVICE_URL || 'http://localhost:3002',
  merchantServiceUrl: process.env.MERCHANT_SERVICE_URL || 'http://localhost:3003',
  walletServiceUrl: process.env.WALLET_SERVICE_URL || 'http://localhost:3004',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  disableGatewayCheck: process.env.DISABLE_GATEWAY_CHECK === 'true'
}
