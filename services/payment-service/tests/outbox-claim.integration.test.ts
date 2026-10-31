import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { PrismaClient } from '@prisma/client'
import { claimPaymentOutboxEvents } from '../src/jobs/payment-outbox-claim'

const databaseUrl = process.env.PAYMENT_OUTBOX_TEST_DATABASE_URL

test('parallel claims are disjoint and expired processing leases are reclaimed', {
  skip: !databaseUrl && 'Set PAYMENT_OUTBOX_TEST_DATABASE_URL to use a real Payment PostgreSQL database'
}, async () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } }
  })
  const aggregateIdPrefix = `lease-test-${randomUUID()}-`
  const ids = Array.from({ length: 20 }, () => randomUUID())
  try {
    await prisma.outboxEvent.createMany({
      data: ids.map(id => ({
        id,
        aggregateId: `${aggregateIdPrefix}${id}`,
        eventType: 'PAYMENT_SUCCESS',
        topic: 'payment.succeeded',
        payload: {
          id: 'payment-lease-test',
          userId: 'lease-test-user',
          amount: '1.00'
        }
      }))
    })

    const now = new Date()
    const [first, second] = await Promise.all([
      claimPaymentOutboxEvents(prisma, now, aggregateIdPrefix),
      claimPaymentOutboxEvents(prisma, now, aggregateIdPrefix)
    ])
    const firstIds = new Set(first.map(row => row.id))
    assert.equal(first.length, 10)
    assert.equal(second.length, 10)
    assert.ok(second.every(row => !firstIds.has(row.id)), 'parallel claims must not overlap')

    const abandonedId = first[0].id
    await prisma.outboxEvent.update({
      where: { id: abandonedId },
      data: { lockedUntil: new Date(now.getTime() - 1000) }
    })
    const recovered = await claimPaymentOutboxEvents(prisma, new Date(), aggregateIdPrefix)
    assert.deepEqual(recovered.map(row => row.id), [abandonedId])
    assert.ok(recovered[0].lockToken !== first[0].lockToken)
  } finally {
    await prisma.outboxEvent.deleteMany({ where: { id: { in: ids } } })
    await prisma.$disconnect()
  }
})
