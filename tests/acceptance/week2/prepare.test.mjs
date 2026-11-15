import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { prepare } from './runtime.mjs'

async function prepared(rootless, verify) {
  const previous = process.env.FINVAULT_ACCEPTANCE_ROOTLESS
  if (rootless) process.env.FINVAULT_ACCEPTANCE_ROOTLESS = '1'
  else delete process.env.FINVAULT_ACCEPTANCE_ROOTLESS
  try {
    const ctx = await prepare()
    const override = JSON.parse(readFileSync(resolve(ctx.directory, 'compose.json'), 'utf8'))
    await verify(ctx, override)
  } finally {
    if (previous === undefined) delete process.env.FINVAULT_ACCEPTANCE_ROOTLESS
    else process.env.FINVAULT_ACCEPTANCE_ROOTLESS = previous
  }
}
test('fresh acceptance overrides use their own Redis secrets and private readable init SQL', async () => {
  await prepared(false, (ctx, override) => {
    for (const [name, filename] of [['redis_password', 'redis_password.txt'], ['redis_url', 'redis_url.txt']]) {
      assert.equal(override.secrets[name].file, resolve(ctx.directory, 'secrets', filename))
      assert.equal(statSync(override.secrets[name].file).mode & 0o777, 0o600)
    }
    assert.equal(statSync(resolve(ctx.directory, 'secrets')).mode & 0o777, 0o700)
    assert.equal(statSync(resolve(ctx.directory, 'secrets/init-db.sql')).mode & 0o777, 0o644)
    assert.equal(override.services.postgres.security_opt, undefined)
  })
})
test('rootless SELinux relaxation applies only to the explicitly opted-in test override', async () => {
  await prepared(true, (_ctx, override) => {
    for (const service of ['postgres', 'redis', 'gateway', 'auth-service', 'user-service', 'wallet-service'])
      assert.deepEqual(override.services[service].security_opt, ['label=disable'])
  })
})
