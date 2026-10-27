// Opt-in adapter for the existing regression suites; never accepts an app DB.
const { readFileSync } = require('node:fs')
module.exports = function acceptanceTestEnv(service) {
  if (!process.env.FINVAULT_ACCEPTANCE_CONFIG) return {}
  if (!['user', 'admin', 'merchant'].includes(service)) throw new Error('Invalid test schema')
  const config = JSON.parse(readFileSync(process.env.FINVAULT_ACCEPTANCE_CONFIG, 'utf8'))
  if (config.purpose !== 'finvault-week2-isolated-regression') throw new Error('Invalid acceptance config')
  const url = new URL(config.databaseUrl)
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/finvault_test' || url.search)
    throw new Error('Acceptance regression requires an isolated localhost finvault_test database')
  return {
    DATABASE_URL: config.databaseUrl + '?schema=' + service + '_test',
    RABBITMQ_URL: config.rabbitmqUrl,
    S3_ENDPOINT: config.storageEndpoint,
    S3_PUBLIC_ENDPOINT: config.storageEndpoint,
    S3_ACCESS_KEY_ID: config.storageAccessKey,
    S3_SECRET_ACCESS_KEY: config.storageSecretKey,
    INTERNAL_KEY: config.internalKey
  }
}
