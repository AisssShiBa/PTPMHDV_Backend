import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPeerWalletPayment, shouldPublishLegacyWalletEvent } from '../src/jobs/wallet-event-routing'

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
