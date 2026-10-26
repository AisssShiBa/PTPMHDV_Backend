import { Router } from 'express'
import multer from 'multer'
import * as controller from '../controllers/userController'
import { validate } from '../middlewares/validate'
import * as schema from '../validations/user.validation'
import { idSchema } from '../validations/common'
const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 2, fields: 1, fieldSize: 200, parts: 4 } })
const documents = upload.fields([{ name: 'front', maxCount: 1 }, { name: 'back', maxCount: 1 }, { name: 'document', maxCount: 1 }])
router.post('/', validate(schema.createUserSchema), controller.createUser)
router.get('/', validate(schema.listUsersSchema), controller.getUsers)
router.get('/lookup', controller.lookupUser)
router.post('/kyc/documents', controller.authorizeMyKyc, documents, controller.submitKyc)
router.get('/me', controller.getMe)
router.get('/me/kyc', controller.getMyKyc)
router.post('/me/kyc', controller.authorizeMyKyc, documents, controller.submitKyc)
router.get('/by-auth/:authUserId', validate(schema.byAuthSchema), controller.getUserByAuthUserId)
router.put('/by-auth/:authUserId', validate(schema.updateByAuthSchema), controller.updateUser)
router.post('/by-auth/:authUserId/kyc', validate(schema.byAuthSchema), controller.authorizeKyc, documents, controller.submitKyc)
router.get('/by-auth/:authUserId/kyc/document', validate(schema.byAuthSchema), controller.authorizeKyc, controller.getKycDocument)
router.get('/:id', validate(idSchema), controller.getUserById)
router.put('/:id', validate(schema.updateUserSchema), controller.updateUser)
router.post('/:id/kyc', validate(idSchema), controller.authorizeKyc, documents, controller.submitKyc)
router.get('/:id/kyc/document', validate(idSchema), controller.authorizeKyc, controller.getKycDocument)
router.patch('/:id/kyc-status', validate(schema.updateKycStatusSchema), controller.updateKycStatus)
router.patch('/:id/kyc-tier', validate(schema.updateKycTierSchema), controller.changeKycTier)
router.get('/:id/kyc/documents', validate(idSchema), controller.getKycDocuments)
export default router
