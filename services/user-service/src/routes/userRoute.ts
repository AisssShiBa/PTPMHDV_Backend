import { Router } from 'express'
import {
  createUser,
  getUserById,
  getUserByAuthUserId,
  updateUser,
  submitKyc,
  updateKycStatus,
  getUsers
} from '../controllers/userController'
import { validate } from '../middlewares/validate'
import {
  createUserSchema,
  updateUserSchema,
  submitKycSchema,
  updateKycStatusSchema
} from '../validations/user.validation'

const router = Router()

router.post('/', validate(createUserSchema), createUser)
router.get('/', getUsers)
router.get('/by-auth/:authUserId', getUserByAuthUserId)
router.get('/:id', getUserById)
router.put('/:id', validate(updateUserSchema), updateUser)
router.post('/:id/kyc', validate(submitKycSchema), submitKyc)
router.patch('/:id/kyc-status', validate(updateKycStatusSchema), updateKycStatus)

export default router

