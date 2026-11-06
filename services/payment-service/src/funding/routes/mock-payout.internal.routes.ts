import { Router } from 'express';
import { requireInternalAuth } from '../../middlewares/internalAuth';
import { validate } from '../../middlewares/validate';
import * as cashOutController from '../controllers/cashout.controller';
import * as schemas from '../validations/cashout.validation';

// Internal-only mock bank control surface. It requires x-internal-key and is
// mounted under /internal, which the gateway never proxies, so a USER cannot
// reach it even if the public whitelist is too broad.
const router = Router();

router.use(requireInternalAuth);
router.get('/:providerRef', validate(schemas.mockPayoutRefSchema), cashOutController.mockPayoutQuery);
router.post('/:providerRef/resolve', validate(schemas.mockPayoutResolveSchema), cashOutController.mockPayoutResolve);

export default router;
