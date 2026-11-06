import { Router } from 'express';
import { requireGateway } from 'finvault-internal-auth';
import { requireTransactionToken } from '../../middlewares/transactionToken';
import { attachRequestId } from '../../middlewares/requestId';
import { validate } from '../../middlewares/validate';
import * as cashOutController from '../controllers/cashout.controller';
import * as schemas from '../validations/cashout.validation';

const router = Router();

router.post('/', requireGateway, attachRequestId, validate(schemas.createCashOutSchema), cashOutController.create);

router.post(
  '/:id/confirm',
  requireGateway,
  requireTransactionToken,
  attachRequestId,
  validate(schemas.confirmCashOutSchema),
  cashOutController.confirm,
);

// Read-only status endpoint: the client polls this after a timeout instead of
// retrying the POST with a new idempotency key.
router.get('/:id', requireGateway, attachRequestId, validate(schemas.cashOutParamSchema), cashOutController.getById);

export default router;
