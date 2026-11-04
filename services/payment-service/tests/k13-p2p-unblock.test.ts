import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient, PaymentStatus, PaymentType } from '@prisma/client'
import { PaymentService } from '../src/services/payment.service'

const prisma = new PrismaClient()

test('K13-3: P2P payments no longer throw P2P_REFUND_UNSUPPORTED upon refund attempt', async () => {
  const paymentService = new PaymentService()
  const paymentId = randomUUID()
  const userId = randomUUID()
  const destinationUserId = randomUUID()

  // Tạo payment P2P ở trạng thái PENDING
  await prisma.payment.create({
    data: {
      id: paymentId,
      userId,
      destinationUserId,
      amount: '50000.00',
      type: PaymentType.WALLET_TRANSFER,
      referenceId: 'ref_' + randomUUID(),
      callbackTopic: 'finvault.events',
      idempotencyKey: randomUUID(),
      requestHash: 'hash_' + randomUUID(),
      idempotencyExpiresAt: new Date(Date.now() + 86400000),
      status: PaymentStatus.PENDING,
    }
  })

  // Gọi refund trên payment PENDING -> phải trả về CONFLICT (Payment is in PENDING status), KHÔNG còn trả P2P_REFUND_UNSUPPORTED
  let errorCaught: any = null
  try {
    await paymentService.refund(paymentId)
  } catch (err: any) {
    errorCaught = err
  }

  assert.ok(errorCaught)
  assert.notEqual(errorCaught.code, 'P2P_REFUND_UNSUPPORTED', 'Should not throw P2P_REFUND_UNSUPPORTED')
  assert.equal(errorCaught.code, 'CONFLICT')

  // Dọn dẹp
  await prisma.payment.delete({ where: { id: paymentId } })
  await prisma.$disconnect()
})
