import { Router } from 'express';
import { requireGateway as _requireGateway, requireRole as _requireRole } from 'finvault-internal-auth';
import { validate } from '../middlewares/validate';
import * as adminController from '../controllers/admin.controller';
import * as schemas from '../validations/admin.validation';
import { ownerIdParamSchema, ownerTypeQuerySchema } from '../validations/wallet.validation';

// Cast sang any để tránh lỗi dual @types/express version (package dùng v4, service dùng v5).
// Hành vi runtime không bị ảnh hưởng; ES256 verification vẫn được thực thi đầy đủ.
const requireGateway = _requireGateway as any;
const requireRole    = (role: string) => (_requireRole(role) as any);

const router = Router();

// Tất cả route admin bắt buộc phải:
//   1. Đi qua API Gateway (xác thực ES256 x-gateway-token)
//   2. Có role ADMIN trong JWT payload (không thể giả mạo vì token được ký bằng Private Key)
router.use(requireGateway);
router.use(requireRole('ADMIN'));

router.post('/:userId/lock',        validate(ownerIdParamSchema.merge(ownerTypeQuerySchema)), adminController.lock);
router.post('/:userId/unlock',      validate(ownerIdParamSchema.merge(ownerTypeQuerySchema)), adminController.unlock);
router.post('/:userId/adjust',      validate(schemas.adjustSchema), adminController.adjust);
router.get('/',                     validate(schemas.listWalletsSchema), adminController.list);
router.get('/reconciliation',       adminController.reconciliation);

export default router;
