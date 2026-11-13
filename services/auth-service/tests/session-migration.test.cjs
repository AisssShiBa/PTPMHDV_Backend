const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { randomUUID } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const container = process.env.AUTH_MIGRATION_TEST_CONTAINER
assert.match(container || '', /^finvault-acceptance-[a-f0-9]{12}-postgres-1$/, 'Set the explicitly isolated acceptance PostgreSQL container')
const migration = readFileSync(resolve(__dirname, '../prisma/migrations/20261112120000_session_refresh_rotation/migration.sql'), 'utf8')
function run(setup, assertions) {
  const schema = 'auth_migration_' + randomUUID().replaceAll('-', '')
  const sql = `BEGIN; CREATE SCHEMA "${schema}"; SET LOCAL search_path TO "${schema}";
    CREATE TABLE "Session" (id TEXT PRIMARY KEY, "refreshToken" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL);
    ${setup}
    ${migration}
    ${assertions}
    ROLLBACK;`
  const result = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}
test('adds rotation fields on a fresh schema and supports the current session insert', () => {
  run('', `INSERT INTO "Session" VALUES ('new', 'synthetic-hash', '2026-12-01', 'synthetic-family', NULL);
    DO $$ BEGIN IF (SELECT "familyId" FROM "Session" WHERE id='new') <> 'synthetic-family' THEN RAISE EXCEPTION 'family missing'; END IF; END $$;`)
})
test('backfills old sessions without changing token hashes or expiry and preserves an existing family on replay', () => {
  run(`INSERT INTO "Session" VALUES ('old-id', 'synthetic-hash', '2026-12-01');`, `
    DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM "Session" WHERE id='old-id' AND "familyId"='old-id' AND "refreshToken"='synthetic-hash' AND "expiresAt"='2026-12-01') THEN RAISE EXCEPTION 'session changed'; END IF; END $$;
    UPDATE "Session" SET "familyId"='preserved-family';
    ${migration}
    DO $$ BEGIN IF (SELECT "familyId" FROM "Session" WHERE id='old-id') <> 'preserved-family' THEN RAISE EXCEPTION 'family overwritten'; END IF; END $$;`)
})
