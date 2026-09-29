const { spawnSync } = require('node:child_process')
const result = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:55432/finvault_test?schema=user_test' }
})
process.exit(result.status ?? 1)

