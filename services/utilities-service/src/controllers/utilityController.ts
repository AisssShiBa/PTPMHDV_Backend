import { UtilityOrder } from '@prisma/client'
import { Request, Response, NextFunction } from 'express'
import { HttpError } from '../utils/errors'
import { amountToIntegerString } from '../utils/money'
import type { OrderView } from '../types/utility'
import type { PaymentClient } from '../types/utility'
import { createUtilityOrder, findOrderForUser } from '../services/orderService'
import { lookupBill } from '../services/billService'
import {
  parseBillPayBody,
  parseTopupBody,
  requireIdempotencyKey
} from '../validations/utility.validation'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const toOrderView = (order: UtilityOrder, replayed?: boolean): OrderView => ({
  orderId: order.id,
  type: order.type,
  status: order.status,
  amount: amountToIntegerString(order.amount),
  discountAmount: amountToIntegerString(order.discountAmount),
  target: order.target,
  providerCode: order.providerCode,
  providerRef: order.providerRef,
  paymentId: order.paymentId,
  failureReason: order.failureReason,
  createdAt: order.createdAt,
  updatedAt: order.updatedAt,
  ...(replayed === undefined ? {} : { replayed })
})

const userIdFrom = (req: Request): string => {
  const userId = req.auth?.userId
  if (!userId) {
    throw new HttpError(401, 'INVALID_GATEWAY_TOKEN', 'Gateway Token không hợp lệ hoặc đã hết hạn.')
  }
  return userId
}

const requestIdFrom = (req: Request): string | undefined => {
  const value = (req as Request & { requestId?: string }).requestId
  return typeof value === 'string' ? value : undefined
}

export const createTopupHandler =
  (paymentClient: PaymentClient) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = userIdFrom(req)
      const idempotencyKey = requireIdempotencyKey(req.get('Idempotency-Key') ?? undefined)
      const { phone, amount } = parseTopupBody(req.body)
      const gatewayToken = req.get('x-gateway-token')
      if (!gatewayToken) {
        throw new HttpError(401, 'INVALID_GATEWAY_TOKEN', 'Gateway Token không hợp lệ hoặc đã hết hạn.')
      }

      const result = await createUtilityOrder(
        {
          userId,
          idempotencyKey,
          type: 'TELCO_TOPUP',
          amount,
          target: phone,
          gatewayToken,
          requestId: requestIdFrom(req)
        },
        paymentClient
      )

      return res.status(result.replayed ? 200 : 201).json({
        success: true,
        data: toOrderView(result.order, result.replayed)
      })
    } catch (error) {
      return next(error)
    }
  }

export const getOrderHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = userIdFrom(req)
    const id = String(req.params.id ?? '')
    if (!UUID_PATTERN.test(id)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'orderId phải là UUID hợp lệ.')
    }
    const order = await findOrderForUser(id, userId)
    return res.status(200).json({ success: true, data: toOrderView(order) })
  } catch (error) {
    return next(error)
  }
}

export const lookupBillHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    userIdFrom(req)
    const provider = typeof req.query.provider === 'string' ? req.query.provider : ''
    const customerCode = typeof req.query.customerCode === 'string' ? req.query.customerCode : ''
    const bill = lookupBill(provider, customerCode)
    return res.status(200).json({
      success: true,
      data: {
        ...bill,
        amountFormatted: `${bill.amount.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}đ`
      }
    })
  } catch (error) {
    return next(error)
  }
}

export const payBillHandler =
  (paymentClient: PaymentClient) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = userIdFrom(req)
      const idempotencyKey = requireIdempotencyKey(req.get('Idempotency-Key') ?? undefined)
      const { provider, customerCode, amount } = parseBillPayBody(req.body)
      const gatewayToken = req.get('x-gateway-token')
      if (!gatewayToken) {
        throw new HttpError(401, 'INVALID_GATEWAY_TOKEN', 'Gateway Token không hợp lệ hoặc đã hết hạn.')
      }

      const bill = lookupBill(provider, customerCode)
      if (BigInt(amount) !== BigInt(bill.amount)) {
        throw new HttpError(409, 'BILL_AMOUNT_MISMATCH', 'Số tiền không khớp với hóa đơn.')
      }

      const result = await createUtilityOrder(
        {
          userId,
          idempotencyKey,
          type: 'BILL_PAY',
          amount,
          target: customerCode,
          providerCode: provider,
          gatewayToken,
          requestId: requestIdFrom(req)
        },
        paymentClient
      )

      return res.status(result.replayed ? 200 : 201).json({
        success: true,
        data: toOrderView(result.order, result.replayed)
      })
    } catch (error) {
      return next(error)
    }
  }
