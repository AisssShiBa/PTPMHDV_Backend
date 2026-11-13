// Isolated PostgreSQL regression: every schema, row and enum is rolled back.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { randomUUID } = require('node:crypto')
const { spawnSync } = require('node:child_process')

const container = process.env.WALLET_MIGRATION_TEST_CONTAINER
assert.match(container || '', /^finvault-acceptance-[a-f0-9]{12}-postgres-1$/, 'Set the explicitly isolated acceptance PostgreSQL container')
const migration = readFileSync(resolve(__dirname, '../prisma/migrations/20261106120000_rename_topup_pool_add_settlement/migration.sql'), 'utf8')
function run(labels, source) {
  const schema = 'wallet_migration_' + randomUUID().replaceAll('-', '')
  const setup = `BEGIN; CREATE SCHEMA "${schema}"; SET LOCAL search_path TO "${schema}";
    CREATE TYPE "SystemWalletCode" AS ENUM (${labels.map((label) => `'${label}'`).join(',')});
    CREATE TABLE "Wallet" (id text PRIMARY KEY, code "SystemWalletCode", balance numeric);
    INSERT INTO "Wallet" VALUES ('preserved-id', '${source}', 123456789012345678);
    ${migration}
    DO $assert$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM "Wallet" WHERE id='preserved-id' AND code::text='CLEARING_TOPUP' AND balance=123456789012345678)
      THEN RAISE EXCEPTION 'wallet identity or money changed'; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid='"SystemWalletCode"'::regtype AND enumlabel='SETTLEMENT')
      THEN RAISE EXCEPTION 'settlement missing'; END IF;
    END $assert$; ROLLBACK;`
  return spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: setup, encoding: 'utf8' })
}
test('renames the legacy label without changing the wallet identity or balance', () => {
  const result = run(['MAIN', 'FEE', 'TOPUP_POOL'], 'TOPUP_POOL')
  assert.equal(result.status, 0, result.stderr)
})
test('accepts a history where the earlier migration already renamed the label', () => {
  const result = run(['SETTLEMENT', 'FEE', 'CLEARING_TOPUP'], 'CLEARING_TOPUP')
  assert.equal(result.status, 0, result.stderr)
})
test('fails closed for an unrelated or incomplete enum rather than hiding schema damage', () => {
  const result = run(['MAIN', 'FEE'], 'MAIN')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /requires TOPUP_POOL or CLEARING_TOPUP/)
})
