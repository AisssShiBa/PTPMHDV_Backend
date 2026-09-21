import { Router } from 'express';
import { requireInternalAuth } from '../middlewares/internalAuth';
import { validate } from '../middlewares/validate';
import * as adminController from '../controllers/admin.controller';
import * as schemas from '../validations/admin.validation';
import { ownerIdParamSchema, ownerTypeQuerySchema } from '../validations/wallet.validation';

const router = Router();

router.use(requireInternalAuth);

router.post('/:userId/lock', validate(ownerIdParamSchema.merge(ownerTypeQuerySchema)), adminController.lock);
router.post('/:userId/unlock', validate(ownerIdParamSchema.merge(ownerTypeQuerySchema)), adminController.unlock);
router.post('/:userId/adjust', validate(schemas.adjustSchema), adminController.adjust);
router.get('/', validate(schemas.listWalletsSchema), adminController.list);
router.get('/reconciliation', adminController.reconciliation);

export default router;
