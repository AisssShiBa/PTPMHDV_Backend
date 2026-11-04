import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient, PaymentStatus, PaymentType } from '@prisma/client'

const prisma = new PrismaClient()

test('K13-2: Payment model supports refund tracking fields with defaults', async () => {
  const paymentId = randomUUID()
  const userId = randomUUID()
  const idempotencyKey = randomUUID()

  // 1. Tạo bản ghi payment mới, kiểm tra các giá trị mặc định của refund fields
  const payment = await prisma.payment.create({
    data: {
      id: paymentId,
      userId,
      amount: '50000.00',
      type: PaymentType.WALLET_TRANSFER,
      referenceId: 'ref_' + randomUUID(),
      callbackTopic: 'finvault.events',
      idempotencyKey,
      requestHash: 'hash_' + randomUUID(),
      idempotencyExpiresAt: new Date(Date.now() + 86400000),
      status: PaymentStatus.PENDING,
    }
  })

  assert.equal(payment.refundAttempts, 0)
  assert.equal(payment.needsAttention, false)
  assert.equal(payment.failureCode, null)
  assert.equal(payment.nextRefundAttemptAt, null)
  assert.equal(payment.refundRequestedAt, null)
  assert.equal(payment.refundedAt, null)

  // 2. Cập nhật các trường refund tracking (giả lập khi chuyển sang REFUNDING / FAILED)
  const requestedAt = new Date()
  const nextAttempt = new Date(Date.now() + 60000)
  const updated = await prisma.payment.update({
    where: { id: paymentId },
    data: {
      status: PaymentStatus.REFUNDING,
      refundRequestedAt: requestedAt,
      refundAttempts: 1,
      nextRefundAttemptAt: nextAttempt,
      failureCode: 'INSUFFICIENT_FUNDS',
      needsAttention: true,
    }
  })

  assert.equal(updated.status, PaymentStatus.REFUNDING)
  assert.equal(updated.refundAttempts, 1)
  assert.equal(updated.needsAttention, true)
  assert.equal(updated.failureCode, 'INSUFFICIENT_FUNDS')
  assert.ok(updated.refundRequestedAt instanceof Date)

  // 3. Truy vấn sử dụng index @@index([status, nextRefundAttemptAt])
  const pendingRefunds = await prisma.payment.findMany({
    where: {
      status: PaymentStatus.REFUNDING,
      nextRefundAttemptAt: { lte: new Date(Date.now() + 120000) }
    }
  })
  assert.ok(pendingRefunds.some(p => p.id === paymentId))

  // Dọn dẹp
  await prisma.payment.delete({ where: { id: paymentId } })
  await prisma.$disconnect()
})
