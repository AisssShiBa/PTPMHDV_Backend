import { Router } from 'express';
import { requireGateway } from '../middlewares/requireGateway';
import { attachRequestId } from '../middlewares/requestId';
import { validate } from '../middlewares/validate';
import * as topupController from '../controllers/topup.controller';
import * as schemas from '../validations/topup.validation';
import { DomainException } from '../utils/domain.exception';

const router = Router();

router.use(requireGateway);
router.use(attachRequestId);
router.use((req: any, res, next) => {
  if (req.userRole !== 'ADMIN') {
    return next(new DomainException(403, 'FORBIDDEN', 'Require ADMIN role'));
  }
  next();
});

router.get('/', topupController.getAdminTopups);
router.post('/:id/approve', validate(schemas.paramIdSchema), topupController.approveTopup);
router.post('/:id/reject', validate(schemas.rejectTopupSchema), topupController.rejectTopup);

export default router;
