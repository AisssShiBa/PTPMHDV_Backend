import { Router } from 'express'
import {
  registerMerchant,
  getMerchantById,
  updateMerchant,
  updateMerchantStatus,
  checkMerchantActive,
  getMerchants
} from '../controllers/merchantController'

const router = Router()

router.post('/register', registerMerchant)
router.get('/', getMerchants)
router.get('/:id/active', checkMerchantActive)
router.get('/:id', getMerchantById)
router.put('/:id', updateMerchant)
router.patch('/:id/status', updateMerchantStatus)

export default router
