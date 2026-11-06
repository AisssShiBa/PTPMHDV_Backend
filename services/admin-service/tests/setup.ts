process.env.NODE_ENV = 'test'
process.env.DATABASE_URL =
  process.env.ADMIN_TEST_DATABASE_URL ??
  'postgresql://notification_test:notification_test@127.0.0.1:5434/admin_test'
process.env.INTERNAL_KEY = 'test-internal-key-01234567890123456789'
process.env.WALLET_SERVICE_URL = 'http://127.0.0.1:59999'
delete process.env.GATEWAY_PUBLIC_KEY
delete process.env.GATEWAY_PUBLIC_KEY_FILE
