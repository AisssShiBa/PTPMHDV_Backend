import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('missing internal key fails startup instead of using a fallback in admin-service (B3)', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', "require('./src/config/env')"], {
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, INTERNAL_KEY: '' },
    encoding: 'utf8',
    windowsHide: true
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Thiếu biến môi trường bắt buộc: INTERNAL_KEY/)
})
