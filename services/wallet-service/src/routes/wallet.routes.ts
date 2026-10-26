import { Router } from 'express';
import { requireGatewayOrInternalKey } from '../middlewares/gatewayOrInternalAuth';
import { attachRequestId } from '../middlewares/requestId';
import { requireOwnerOrAdmin } from '../middlewares/requireOwnerOrAdmin';
import { requireInternalOrAdmin } from '../middlewares/requireInternalOrAdmin';
import { validate } from '../middlewares/validate';
import * as walletController from '../controllers/wallet.controller';
import * as schemas from '../validations/wallet.validation';

const router = Router();

// 1. Xác thực: Gateway Token (ES256) hoặc Internal Service Key (timingSafeEqual)
//    KHÔNG còn fallback nào tin x-gateway-verified header do client tự gán.
router.use(requireGatewayOrInternalKey);

// 2. Gán request ID để truy vết log
router.use(attachRequestId);

// 3. Kiểm tra quyền sở hữu ví: user chỉ được tác động lên ví của chính mình,
//    trừ khi là ADMIN (req.auth.role) hoặc internal service call (req.isInternalCall).
//
// TODO(kycTier): Enforce hạn mức chuyển tiền dựa trên req.auth.kycTier khi có spec nghiệp vụ:
//   - kycTier 0 (Chưa KYC): Hạn mức = ?
//   - kycTier 1 (Cơ bản):   Hạn mức = ?
//   - kycTier 2 (Nâng cao):  Hạn mức = không giới hạn (hoặc giới hạn cao)
//   Xem req.auth.kycTier trong controller sau khi requireGateway đã inject.
router.use(requireOwnerOrAdmin);

router.post('/', validate(schemas.createWalletSchema), walletController.create);
router.get('/:userId/balance', validate(schemas.ownerIdParamSchema.merge(schemas.ownerTypeQuerySchema)), walletController.getBalance);
router.post('/:userId/hold', requireInternalOrAdmin, validate(schemas.holdSchema), walletController.hold);
router.post('/:userId/capture', requireInternalOrAdmin, validate(schemas.referenceSchema), walletController.capture);
router.post('/:userId/release', requireInternalOrAdmin, validate(schemas.referenceSchema), walletController.release);
router.post('/:userId/transfer', requireInternalOrAdmin, validate(schemas.transferSchema), walletController.transfer);

// credit và debit chỉ dành cho internal service call hoặc ADMIN (không phải USER thông thường)
router.post('/:userId/credit', requireInternalOrAdmin, validate(schemas.creditDebitSchema), walletController.credit);
router.post('/:userId/debit',  requireInternalOrAdmin, validate(schemas.creditDebitSchema), walletController.debit);

router.get('/:userId/history', validate(schemas.historyQuerySchema), walletController.history);

export default router;
