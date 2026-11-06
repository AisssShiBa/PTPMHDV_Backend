import './setup'
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { eventPayloadHash } from 'finvault-events'
import type { FinvaultEvent } from 'finvault-events'
import { prisma } from '../src/config/prisma'
import { PaymentClientError } from '../src/services/paymentClient'
import { createUtilityInbox } from '../src/services/utilityInbox'
import { handleUtilityEvent } from '../src/services/utilityEventsConsumer'
import { runRecoveryOnce } from '../src/services/recoveryService'
import {
  clearDatabase,
  createOrder,
  eventOf,
  FakePaymentClient,
  FakeProviderClient
} from './helpers'

const setup = () => {
  const paymentClient = new FakePaymentClient()
  const providerClient = new FakeProviderClient()
  const inbox = createUtilityInbox(prisma)
  const deliver = async (event: ReturnType<typeof eventOf>) =>
    inbox.runOnce(
      {
        eventId: event.eventId,
        eventType: event.eventType,
        payloadHash: eventPayloadHash(event as unknown as FinvaultEvent)
      },
      tx => handleUtilityEvent(event as unknown as FinvaultEvent, { tx }, { paymentClient, providerClient })
    )
  return { paymentClient, providerClient, deliver }
}

const makeOld = async (orderId: string, minutes = 10) => {
  await prisma.utilityOrder.update({
    where: { id: orderId },
    data: {
      updatedAt: new Date(Date.now() - minutes * 60_000),
      createdAt: new Date(Date.now() - minutes * 60_000)
    }
  })
}

beforeEach(clearDatabase)

test('payment.succeeded fulfils the order once and stores the provider reference', async () => {
  const { providerClient, deliver } = setup()
  const order = await createOrder({ paymentId: 'pay-1' })
  providerClient.outcome = { status: 'SUCCESS', providerRef: `MOCK-${order.id}` }

  const result = await deliver(eventOf('payment.succeeded', { paymentId: 'pay-1' }))
  const saved = await prisma.utilityOrder.findUniqueOrThrow({ where: { id: order.id } })

  assert.equal(result.status, 'processed')
  assert.equal(saved.status, 'SUCCESS')
  assert.equal(saved.providerRef, `MOCK-${order.id}`)
  assert.equal(providerClient.calls.length, 1)
})

test('a duplicate event with the same eventId calls the provider only once', async () => {
  const { providerClient, deliver } = setup()
  await createOrder({ paymentId: 'pay-1' })
  const event = eventOf('payment.succeeded', { paymentId: 'pay-1' })

  await deliver(event)
  const second = await deliver(event)

  assert.equal(second.status, 'duplicate')
  assert.equal(providerClient.calls.length, 1)
})

test('two events with different eventIds for one payment still fulfil once', async () => {
  const { providerClient, deliver } = setup()
  await createOrder({ paymentId: 'pay-1' })

  await deliver(eventOf('payment.succeeded', { paymentId: 'pay-1' }))
  await deliver(eventOf('payment.succeeded', { paymentId: 'pay-1' }))

  assert.equal(providerClient.calls.length, 1)
})

test('a payment that belongs to no utilities order is acknowledged without side effects', async () => {
  const { providerClient, deliver } = setup()
  const result = await deliver(eventOf('payment.succeeded', { paymentId: 'not-ours' }))

  assert.equal(result.status, 'processed')
  assert.equal(providerClient.calls.length, 0)
  assert.equal(await prisma.utilityOrder.count(), 0)
})

test('payment.failed marks the order FAILED without requesting a refund', async () => {
  const { paymentClient, providerClient, deliver } = setup()
  const order = await createOrder({ paymentId: 'pay-1' })

  await deliver(eventOf('payment.failed', { paymentId: 'pay-1', senderId: 'sender', reason: 'x' }))
  const saved = await prisma.utilityOrder.findUniqueOrThrow({ where: { id: order.id } })

  assert.equal(saved.status, 'FAILED')
  assert.equal(saved.failureReason, 'PAYMENT_FAILED')
  assert.equal(providerClient.calls.length, 0)
  assert.equal(paymentClient.refundCalls.length, 0)
})

test('payment.expired marks the order FAILED without requesting a refund', async () => {
  const { paymentClient, deliver } = setup()
  const order = await createOrder({ paymentId: 'pay-1' })

  await deliver(eventOf('payment.expired', { paymentId: 'pay-1', senderId: 'sender' }))
  const saved = await prisma.utilityOrder.findUniqueOrThrow({ where: { id: order.id } })

  assert.equal(saved.status, 'FAILED')
  assert.equal(saved.failureReason, 'PAYMENT_EXPIRED')
  assert.equal(paymentClient.refundCalls.length, 0)
})

test('a provider timeout keeps PROVIDER_PENDING and never refunds', async () => {
  const { paymentClient, providerClient, deliver } = setup()
  providerClient.outcome = { status: 'TIMEOUT' }
  const order = await createOrder({ paymentId: 'pay-1' })

  await deliver(eventOf('payment.succeeded', { paymentId: 'pay-1' }))
  const pending = await prisma.utilityOrder.findUniqueOrThrow({ where: { id: order.id } })

  assert.equal(pending.status, 'PROVIDER_PENDING')
  assert.equal(paymentClient.refundCalls.length, 0)

  providerClient.queryOutcome = { status: 'SUCCESS', providerRef: `MOCK-${order.id}` }
  await makeOld(order.id)
  await runRecoveryOnce({ paymentClient, providerClient }, new Date(), 60_000)
  const settled = await prisma.utilityOrder.findUniqueOrThrow({ where: { id: order.id } })

  assert.equal(settled.status, 'SUCCESS')
  assert.equal(settled.providerRef, `MOCK-${order.id}`)
})

test('a definite provider failure requests one refund and stores REFUNDED', async () => {
  const { paymentClient, providerClient, deliver } = setup()
  providerClient.outcome = { status: 'FAILED', reason: 'PROVIDER_REJECTED' }
  const order = await createOrder({ paymentId: 'pay-1' })

  await deliver(eventOf('payment.succeeded', { paymentId: 'pay-1' }))
  const saved = await prisma.utilityOrder.findUniqueOrThrow({ where: { id: order.id } })

  assert.deepEqual(paymentClient.refundCalls, ['pay-1'])
  assert.equal(saved.status, 'REFUNDED')
})

test('a definite refund rejection stores REFUND_FAILED and is not retried forever', async () => {
  const { paymentClient, providerClient, deliver } = setup()
  providerClient.outcome = { status: 'FAILED', reason: 'PROVIDER_REJECTED' }
  paymentClient.refundHandler = async () => {
    throw new PaymentClientError('rejected', 409, 'P2P_REFUND_UNSUPPORTED', true)
  }
  const order = await createOrder({ paymentId: 'pay-1' })

  await deliver(eventOf('payment.succeeded', { paymentId: 'pay-1' }))
  const saved = await prisma.utilityOrder.findUniqueOrThrow({ where: { id: order.id } })

  assert.equal(saved.status, 'REFUND_FAILED')
  assert.equal(saved.failureReason, 'P2P_REFUND_UNSUPPORTED')
  assert.equal(paymentClient.refundCalls.length, 1)

  await makeOld(order.id)
  await runRecoveryOnce({ paymentClient, providerClient }, new Date(), 60_000)
  assert.equal(paymentClient.refundCalls.length, 1)
})

test('the recovery job finishes an order that stopped after PAID', async () => {
  const { paymentClient, providerClient } = setup()
  const order = await createOrder({ paymentId: 'pay-1', status: 'PAID' })
  await makeOld(order.id)
  providerClient.outcome = { status: 'SUCCESS', providerRef: `MOCK-${order.id}` }

  await runRecoveryOnce({ paymentClient, providerClient }, new Date(), 60_000)
  const saved = await prisma.utilityOrder.findUniqueOrThrow({ where: { id: order.id } })

  assert.equal(saved.status, 'SUCCESS')
  assert.equal(providerClient.calls.length, 1)

  await runRecoveryOnce({ paymentClient, providerClient }, new Date(), 60_000)
  assert.equal(providerClient.calls.length, 1)
})

test('the recovery job fails an abandoned checkout with no payment after two minutes', async () => {
  const { paymentClient, providerClient } = setup()
  const order = await createOrder({ paymentId: null })
  await makeOld(order.id, 5)

  await runRecoveryOnce({ paymentClient, providerClient }, new Date(), 60_000)
  const saved = await prisma.utilityOrder.findUniqueOrThrow({ where: { id: order.id } })

  assert.equal(saved.status, 'FAILED')
  assert.equal(saved.failureReason, 'CHECKOUT_NOT_CREATED')
})

test('refund retries stop at five attempts', async () => {
  const { paymentClient, providerClient } = setup()
  const order = await createOrder({ paymentId: 'pay-1', status: 'REFUND_REQUESTED' })
  await prisma.utilityOrder.update({
    where: { id: order.id },
    data: { refundAttempts: 5 }
  })
  await makeOld(order.id)

  await runRecoveryOnce({ paymentClient, providerClient }, new Date(), 60_000)
  assert.equal(paymentClient.refundCalls.length, 0)
})
