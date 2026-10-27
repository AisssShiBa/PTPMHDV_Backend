const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, dirname, resolve } = require('node:path')
const { loadSecretEnvironment } = require('../dist')

test('file secrets override inline values and unreadable/empty files fail closed without leaking values', t => {
  const parent = resolve(tmpdir())
  const directory = mkdtempSync(join(parent, 'finvault-secret-test-'))
  const original = { key: process.env.INTERNAL_KEY, file: process.env.INTERNAL_KEY_FILE }
  t.after(() => {
    for (const [key, value] of [['INTERNAL_KEY', original.key], ['INTERNAL_KEY_FILE', original.file]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    assert.equal(dirname(directory), parent)
    assert.ok(directory.startsWith(join(parent, 'finvault-secret-test-')))
    rmSync(directory, { recursive: true, force: true })
  })
  process.env.INTERNAL_KEY = 'inline-value'
  delete process.env.INTERNAL_KEY_FILE
  loadSecretEnvironment(['INTERNAL_KEY'])
  assert.equal(process.env.INTERNAL_KEY, 'inline-value')
  const file = join(directory, 'key.txt')
  writeFileSync(file, '  fixture-file-secret\n')
  process.env.INTERNAL_KEY_FILE = file
  loadSecretEnvironment(['INTERNAL_KEY'])
  assert.equal(process.env.INTERNAL_KEY, 'fixture-file-secret')
  writeFileSync(file, '   \n')
  assert.throws(() => loadSecretEnvironment(['INTERNAL_KEY']), /^Error: Empty required secret: INTERNAL_KEY_FILE$/)
  process.env.INTERNAL_KEY_FILE = join(directory, 'missing')
  assert.throws(() => loadSecretEnvironment(['INTERNAL_KEY']), /^Error: Cannot read required secret: INTERNAL_KEY_FILE$/)
})
