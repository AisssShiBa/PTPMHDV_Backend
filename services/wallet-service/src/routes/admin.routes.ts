import { Router } from 'express';
import { requireAdminAuth } from '../middlewares/adminAuth';
import { validate } from '../middlewares/validate';
import * as adminController from '../controllers/admin.controller';
import * as schemas from '../validations/admin.validation';
import { ownerIdParamSchema, ownerTypeQuerySchema } from '../validations/wallet.validation';

const router = Router();

router.use(requireAdminAuth);

router.post('/:userId/lock', validate(ownerIdParamSchema.merge(ownerTypeQuerySchema)), adminController.lock);
router.post('/:userId/unlock', validate(ownerIdParamSchema.merge(ownerTypeQuerySchema)), adminController.unlock);
router.post('/:userId/adjust', validate(schemas.adjustSchema), adminController.adjust);
router.get('/', validate(schemas.listWalletsSchema), adminController.list);
router.get('/reconciliation', adminController.reconciliation);

export default router;
