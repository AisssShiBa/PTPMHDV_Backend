import express from 'express'
import {
  signUp,
  signIn,
  refresh,
  signOut
} from '../controllers/authController'
import { validateRequest } from '../middlewares/validateRequest'
import { rateLimiter } from '../middlewares/rateLimiter'
import { signUpSchema, signInSchema } from '../validations/authValidation'

const router = express.Router()

// 1. Đăng ký tài khoản (Có giới hạn tần suất và validate dữ liệu)
router.post(
  '/signup',
  rateLimiter(15 * 60 * 1000, 30),
  validateRequest(signUpSchema),
  signUp
)

// 2. Đăng nhập hệ thống (Có giới hạn tần suất và validate dữ liệu)
router.post(
  '/signin',
  rateLimiter(15 * 60 * 1000, 30),
  validateRequest(signInSchema),
  signIn
)

// 3. Làm mới Access Token
router.post('/refresh', refresh)

// 4. Đăng xuất tài khoản
router.post('/signout', signOut)

export default router
