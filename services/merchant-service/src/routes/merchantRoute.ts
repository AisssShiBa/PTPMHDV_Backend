import { Router } from 'express'
import {
  registerMerchant,
  getMerchantById,
  updateMerchant,
  updateMerchantStatus,
  checkMerchantActive,
  getMerchants
} from '../controllers/merchantController'
import { validate } from '../middlewares/validate'
import {
  registerMerchantSchema,
  updateMerchantSchema,
  updateMerchantStatusSchema
} from '../validations/merchant.validation'

const router = Router()

router.post('/register', validate(registerMerchantSchema), registerMerchant)
router.get('/', getMerchants)
router.get('/:id/active', checkMerchantActive)
router.get('/:id', getMerchantById)
router.put('/:id', validate(updateMerchantSchema), updateMerchant)
router.patch('/:id/status', validate(updateMerchantStatusSchema), updateMerchantStatus)

export default router

