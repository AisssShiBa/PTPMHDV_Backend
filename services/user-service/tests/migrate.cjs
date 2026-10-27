const { spawnSync } = require('node:child_process')
const acceptanceEnv = require('../../../tests/acceptance/week2/test-env.cjs')
const result = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:25432/finvault_test?schema=user_test', ...acceptanceEnv('user') }
})
if (result.status !== 0) process.exit(result.status ?? 1)
const path = require('node:path')
const admin = spawnSync(process.execPath, [path.resolve('../admin-service/node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
  cwd: path.resolve('../admin-service'), stdio: 'inherit', windowsHide: true,
  env: { ...process.env, DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:25432/finvault_test?schema=admin_test', ...acceptanceEnv('admin') }
})
process.exit(admin.status ?? 1)

