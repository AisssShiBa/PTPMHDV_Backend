process.env.NODE_ENV = 'test'
process.env.INTERNAL_KEY = 'test-internal-key-01234567890123456789'
process.env.DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/auth_test'
process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret-01234567890123456789'
delete process.env.GATEWAY_PUBLIC_KEY
delete process.env.GATEWAY_PUBLIC_KEY_FILE
