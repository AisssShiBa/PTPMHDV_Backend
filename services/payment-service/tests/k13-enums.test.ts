import test from 'node:test'
import assert from 'node:assert/strict'
import { PaymentStatus, PaymentType } from '../src/utils/enums'
import { checkoutSchema } from '../src/validations/payment.validation'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

test('K13-1: PaymentStatus and PaymentType enums include refund and new payment types', () => {
  // 1. Kiểm tra enum PaymentStatus có đủ REFUNDING và REFUND_FAILED
  assert.equal(PaymentStatus.REFUNDING, 'REFUNDING')
  assert.equal(PaymentStatus.REFUND_FAILED, 'REFUND_FAILED')

  // 2. Kiểm tra enum PaymentType có đủ PHONE_TOPUP và BILL_PAYMENT
  assert.equal(PaymentType.PHONE_TOPUP, 'PHONE_TOPUP')
  assert.equal(PaymentType.BILL_PAYMENT, 'BILL_PAYMENT')
})

test('K13-1: checkoutSchema validation accepts PHONE_TOPUP and BILL_PAYMENT', () => {
  const phoneTopupResult = checkoutSchema.safeParse({
    body: {
      amount: '50000.00',
      type: 'PHONE_TOPUP',
      callbackTopic: 'finvault.events'
    }
  })
  assert.equal(phoneTopupResult.success, true)

  const billPaymentResult = checkoutSchema.safeParse({
    body: {
      amount: '120000.00',
      type: 'BILL_PAYMENT',
      callbackTopic: 'finvault.events'
    }
  })
  assert.equal(billPaymentResult.success, true)
})

test('K13-1: Database metadata confirms PostgreSQL enums contain new values', async () => {
  const statusValues = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
    SELECT e.enumlabel
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'PaymentStatus'
  `
  const labels = statusValues.map(r => r.enumlabel)
  assert.ok(labels.includes('REFUNDING'), 'PaymentStatus must include REFUNDING')
  assert.ok(labels.includes('REFUND_FAILED'), 'PaymentStatus must include REFUND_FAILED')

  const typeValues = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
    SELECT e.enumlabel
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'PaymentType'
  `
  const typeLabels = typeValues.map(r => r.enumlabel)
  assert.ok(typeLabels.includes('PHONE_TOPUP'), 'PaymentType must include PHONE_TOPUP')
  assert.ok(typeLabels.includes('BILL_PAYMENT'), 'PaymentType must include BILL_PAYMENT')

  await prisma.$disconnect()
})
