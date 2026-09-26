import { Router } from 'express'
import multer from 'multer'
import * as controller from '../controllers/userController'
import { validate } from '../middlewares/validate'
import * as schema from '../validations/user.validation'
import { idSchema } from '../validations/common'
const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 1, fieldSize: 200, parts: 2 } })
router.post('/', validate(schema.createUserSchema), controller.createUser)
router.get('/', validate(schema.listUsersSchema), controller.getUsers)
router.get('/by-auth/:authUserId', validate(schema.byAuthSchema), controller.getUserByAuthUserId)
router.put('/by-auth/:authUserId', validate(schema.updateByAuthSchema), controller.updateUser)
router.post('/by-auth/:authUserId/kyc', validate(schema.byAuthSchema), controller.authorizeKyc, upload.single('document'), controller.submitKyc)
router.get('/by-auth/:authUserId/kyc/document', validate(schema.byAuthSchema), controller.authorizeKyc, controller.getKycDocument)
router.get('/:id', validate(idSchema), controller.getUserById)
router.put('/:id', validate(schema.updateUserSchema), controller.updateUser)
router.post('/:id/kyc', validate(idSchema), controller.authorizeKyc, upload.single('document'), controller.submitKyc)
router.get('/:id/kyc/document', validate(idSchema), controller.authorizeKyc, controller.getKycDocument)
router.patch('/:id/kyc-status', validate(schema.updateKycStatusSchema), controller.updateKycStatus)
export default router
