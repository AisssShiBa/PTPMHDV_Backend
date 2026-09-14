import { Router } from 'express';
import { requireInternalAuth } from '../middlewares/internalAuth';
import { validate } from '../middlewares/validate';
import * as walletController from '../controllers/wallet.controller';
import * as schemas from '../validations/wallet.validation';

const router = Router();

router.use(requireInternalAuth);

router.post('/', validate(schemas.createWalletSchema), walletController.create);
router.get('/:userId/balance', validate(schemas.ownerIdParamSchema.merge(schemas.ownerTypeQuerySchema)), walletController.getBalance);
router.post('/:userId/hold', validate(schemas.holdSchema), walletController.hold);
router.post('/:userId/capture', validate(schemas.referenceSchema), walletController.capture);
router.post('/:userId/release', validate(schemas.referenceSchema), walletController.release);
router.post('/transfer', validate(schemas.transferSchema), walletController.transfer);
router.post('/:userId/credit', validate(schemas.creditDebitSchema), walletController.credit);
router.post('/:userId/debit', validate(schemas.creditDebitSchema), walletController.debit);
router.get('/:userId/history', validate(schemas.historyQuerySchema), walletController.history);

export default router;
