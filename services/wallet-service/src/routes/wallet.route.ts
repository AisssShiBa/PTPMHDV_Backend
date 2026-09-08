import { Router } from 'express'
import { requireInternalRequest } from '../middlewares/internalRequest'
import {
  createWalletHandler,
  creditHandler,
  debitHandler,
  getBalanceHandler,
  historyHandler
} from '../controllers/wallet.controller'

const router = Router()

router.post('/', requireInternalRequest, createWalletHandler)
router.get('/:userId/balance', getBalanceHandler)
router.post('/:userId/credit', requireInternalRequest, creditHandler)
router.post('/:userId/debit', requireInternalRequest, debitHandler)
router.get('/:userId/history', historyHandler)

export default router
