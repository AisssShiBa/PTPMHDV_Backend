import dotenv from 'dotenv'
dotenv.config()

export const env = {
  port: parseInt(process.env.PORT || '3003', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/merchant_service',
  internalKey: process.env.INTERNAL_KEY || 'default_internal_secret_key_123456'
}

