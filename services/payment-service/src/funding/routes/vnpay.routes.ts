import { Router } from 'express';
import { requireGateway } from 'finvault-internal-auth';
import { attachRequestId } from '../../middlewares/requestId';
import { validate } from '../../middlewares/validate';
import * as topupController from '../../controllers/topup.controller';
import * as schemas from '../../validations/topup.validation';

// Alias router for /api/funding/vnpay. It is a thin adapter over the same
// TopupService/controller used by /api/payments/topups — no second copy of the
// business logic, so both paths resolve to exactly one transaction.
const router = Router();

// Public callbacks: authenticated by the VNPAY HMAC checksum, not by a Bearer
// token. The gateway public whitelist is owned by another team member; until it
// is narrowed these routes are still safe because the signature is verified
// inside the service before any state change.
router.get('/ipn', topupController.vnpayIpn);
router.get('/return', topupController.vnpayReturn);

router.post('/', requireGateway, attachRequestId, validate(schemas.createTopupSchema), topupController.createTopup);
router.post('/create', requireGateway, attachRequestId, validate(schemas.createTopupSchema), topupController.createTopup);

export default router;
