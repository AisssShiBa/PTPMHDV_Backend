import { Router } from 'express';
import { requireGatewayOrInternal } from '../middlewares/gatewayOrInternalAuth';
import { attachRequestId } from '../middlewares/requestId';
import { requireOwnerOrAdmin } from '../middlewares/requireOwnerOrAdmin';
import { validate } from '../middlewares/validate';
import * as walletController from '../controllers/wallet.controller';
import * as schemas from '../validations/wallet.validation';

const router = Router();

router.use(requireGatewayOrInternal);

// Gán request ID và user info từ gateway
router.use(attachRequestId);

// Đảm bảo user chỉ được tác động lên ví của mình (hoặc là Admin/Internal)
router.use(requireOwnerOrAdmin);

router.post('/', validate(schemas.createWalletSchema), walletController.create);
router.get('/:userId/balance', validate(schemas.ownerIdParamSchema.merge(schemas.ownerTypeQuerySchema)), walletController.getBalance);
router.post('/:userId/hold', validate(schemas.holdSchema), walletController.hold);
router.post('/:userId/capture', validate(schemas.referenceSchema), walletController.capture);
router.post('/:userId/release', validate(schemas.referenceSchema), walletController.release);
router.post('/:userId/transfer', validate(schemas.transferSchema), walletController.transfer);
router.post('/:userId/credit', validate(schemas.creditDebitSchema), walletController.credit);
router.post('/:userId/debit', validate(schemas.creditDebitSchema), walletController.debit);
router.get('/:userId/history', validate(schemas.historyQuerySchema), walletController.history);

export default router;
