import dotenv from 'dotenv'
dotenv.config()

export const env = {
  port: parseInt(process.env.PORT || '3002', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/user_service',
  jwtSecret: process.env.JWT_SECRET || 'your_default_jwt_secret_key_must_be_at_least_32_bytes_long',
  internalKey: process.env.INTERNAL_KEY || 'default_internal_secret_key_123456'
}
