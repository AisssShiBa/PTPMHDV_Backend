import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executionFailure } from './reporting.mjs'

test('fetch connection failures retain their nested network code', () => {
  assert.match(executionFailure(new TypeError('fetch failed', {
    cause: Object.assign(new Error('connection failed'), { code: 'ECONNREFUSED' })
  })), /ECONNREFUSED/)
})

test('process failures never serialize secrets from messages, arguments or output', () => {
  const secret = 'private-credential'
  const reason = executionFailure({ code: 'ETIMEDOUT', message: secret,
    stdout: secret, stderr: secret, spawnargs: [secret], cause: { code: secret, message: secret } })
  assert.match(reason, /ETIMEDOUT/)
  assert.equal(reason.includes(secret), false)
})
