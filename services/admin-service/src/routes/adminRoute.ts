import { Router } from 'express'
import { AdminController } from '../controllers/adminController'

const router = Router()

// 1. Dashboard Thống kê tổng quan
router.get('/dashboard', AdminController.getDashboardStats)
router.get('/dashboard/stats', AdminController.getDashboardStats)

// 2. Quản lý & Phê duyệt KYC người dùng
router.get('/kyc', AdminController.getKycList)
router.post('/kyc/:userId/review', AdminController.reviewKyc)
router.patch('/kyc/:userId/status', AdminController.reviewKyc)

// 3. Quản lý & Phê duyệt Merchant đối tác
router.get('/merchants', AdminController.getMerchantList)
router.post('/merchants/:merchantId/review', AdminController.reviewMerchant)
router.patch('/merchants/:merchantId/status', AdminController.reviewMerchant)

// 4. Lịch sử kiểm toán AdminAuditLog
router.get('/audit-logs', AdminController.getAuditLogs)

export default router
