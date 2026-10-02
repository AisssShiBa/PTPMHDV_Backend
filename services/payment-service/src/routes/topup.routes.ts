import { Router } from 'express';
import { requireGateway } from '../middlewares/requireGateway';
import { attachRequestId } from '../middlewares/requestId';
import { validate } from '../middlewares/validate';
import * as topupController from '../controllers/topup.controller';
import * as schemas from '../validations/topup.validation';

const router = Router();

router.use(requireGateway);
router.use(attachRequestId);

router.post('/', validate(schemas.createTopupSchema), topupController.createTopup);
router.get('/', topupController.getMyTopups);
router.get('/:id', validate(schemas.paramIdSchema), topupController.getTopup);

export default router;
