import { Router } from 'express'
import * as controller from '../controllers/merchantController'
import * as schema from '../validations/merchant.validation'
import { idSchema } from '../validations/common'
import { validate } from '../middlewares/validate'
const router = Router()
router.post('/register', validate(schema.registerMerchantSchema), controller.registerMerchant)
router.get('/', validate(schema.listMerchantsSchema), controller.getMerchants)
router.get('/:id/active', validate(idSchema), controller.checkMerchantActive)
router.get('/:id', validate(idSchema), controller.getMerchantById)
router.put('/:id', validate(schema.updateMerchantSchema), controller.updateMerchant)
router.patch('/:id/status', validate(schema.updateMerchantStatusSchema), controller.updateMerchantStatus)
export default router
