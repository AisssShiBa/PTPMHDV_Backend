import { Router } from 'express'
import {
  createTopupHandler,
  getOrderHandler,
  lookupBillHandler,
  payBillHandler
} from '../controllers/utilityController'
import type { PaymentClient } from '../types/utility'

export function createUtilityRouter(paymentClient: PaymentClient): Router {
  const router = Router()
  router.post('/topup', createTopupHandler(paymentClient))
  router.get('/orders/:id', getOrderHandler)
  router.get('/bills/lookup', lookupBillHandler)
  router.post('/bills/pay', payBillHandler(paymentClient))
  return router
}
