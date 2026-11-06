import { Router } from 'express'
import {
  createMockOrderStatusHandler,
  createMockTopupHandler
} from '../controllers/mockProviderController'
import { requireInternalKey } from '../middlewares/internalAuth'
import type { MockProviderEngine } from '../services/mockProviderEngine'

export function createMockProviderRouter(engine: MockProviderEngine): Router {
  const router = Router()
  router.use(requireInternalKey)
  router.post('/topup', createMockTopupHandler(engine))
  router.get('/orders/:orderId', createMockOrderStatusHandler(engine))
  return router
}
