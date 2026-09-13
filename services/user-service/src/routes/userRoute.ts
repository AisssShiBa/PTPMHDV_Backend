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

const router = Router()

router.post('/', createUser)
router.get('/', getUsers)
router.get('/by-auth/:authUserId', getUserByAuthUserId)
router.get('/:id', getUserById)
router.put('/:id', updateUser)
router.post('/:id/kyc', submitKyc)
router.patch('/:id/kyc-status', updateKycStatus)

export default router
