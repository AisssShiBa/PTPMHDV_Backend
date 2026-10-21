import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseFinvaultEvent } from 'finvault-events'

test('notification service can import the shared event package', () => {
  assert.equal(typeof parseFinvaultEvent, 'function')
})
