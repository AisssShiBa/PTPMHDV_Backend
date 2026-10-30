import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isPeerWalletPayment,
  createWalletOutboxDrain,
  shouldPublishLegacyWalletEvent,
  validateWalletOutboxPayload
} from '../src/jobs/wallet-event-routing'

test('suppresses legacy wallet notifications for P2P transfer outbox rows', () => {
  assert.equal(shouldPublishLegacyWalletEvent({ transferType: 'P2P_TRANSFER' }), false)
  assert.equal(shouldPublishLegacyWalletEvent({ transferType: 'PAYMENT', isPeerTransfer: true }), false)
  assert.equal(shouldPublishLegacyWalletEvent({ transferType: 'PAYMENT', isPeerTransfer: false }), true)
  assert.equal(shouldPublishLegacyWalletEvent({ transferType: 'TOPUP' }), true)
})

test('marks user-to-user PAYMENT captures to suppress duplicate wallet notices', () => {
  assert.equal(isPeerWalletPayment('PAYMENT', 'USER', 'USER'), true)
  assert.equal(isPeerWalletPayment('PAYMENT', 'USER', 'SYSTEM'), false)
  assert.equal(isPeerWalletPayment('P2P_TRANSFER', 'USER', 'USER'), false)
})

test('rejects malformed wallet outbox rows instead of retrying them indefinitely', () => {
  assert.throws(
    () => validateWalletOutboxPayload('wallet.balance_deducted', { amount: '50000' }),
    /userId/
  )
  assert.throws(
    () => validateWalletOutboxPayload('wallet.other', {
      userId: 'user-1',
      amount: '50000',
      balanceAfter: '0',
      transferType: 'TOPUP'
    }),
    /topic/
  )
})

test('parallel wallet drains share one claim operation', async () => {
  let claims = 0
  let releaseDrain: (() => void) | undefined
  const drain = createWalletOutboxDrain(async () => {
    claims += 1
    await new Promise<void>(resolve => { releaseDrain = resolve })
  })

  const first = drain()
  const second = drain()
  await Promise.resolve()
  assert.equal(first, second)
  assert.equal(claims, 1)
  releaseDrain?.()
  await Promise.all([first, second])
  assert.equal(claims, 1)
})
