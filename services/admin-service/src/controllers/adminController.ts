import { Response } from 'express'
import { RequestWithContext } from '../middlewares/requestId'
import { DashboardService } from '../services/dashboardService'
import { KycService } from '../services/kycService'
import { MerchantAdminService } from '../services/merchantAdminService'
import { AuditService } from '../services/auditService'

export const AdminController = {
  /**
   * GET /api/admin/dashboard
   * Lấy tổng quan số liệu thống kê thật
   */
  getDashboardStats: async (req: RequestWithContext, res: Response) => {
    try {
      const stats = await DashboardService.getOverviewStats(req.requestId || 'req-unknown')
      return res.json({
        success: true,
        data: stats,
        message: 'Lấy dữ liệu thống kê Dashboard thành công'
      })
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: {
          code: 'DASHBOARD_ERROR',
          message: err.message || 'Không thể tổng hợp dữ liệu thống kê Dashboard'
        }
      })
    }
  },

  /**
   * GET /api/admin/kyc
   * Lấy danh sách hồ sơ KYC thật
   */
  getKycList: async (req: RequestWithContext, res: Response) => {
    try {
      const page = parseInt(req.query.page as string || '1', 10)
      const limit = parseInt(req.query.limit as string || '10', 10)
      const search = (req.query.search as string || '').trim()
      const status = req.query.status as any

      const result = await KycService.getKycList(
        { page, limit, search, status },
        req.requestId || 'req-unknown'
      )

      return res.json({
        success: true,
        data: result,
        message: 'Lấy danh sách KYC thành công'
      })
    } catch (err: any) {
      return res.status(502).json({
        success: false,
        error: {
          code: 'KYC_FETCH_FAILED',
          message: err.message || 'Không thể lấy danh sách KYC từ user-service'
        }
      })
    }
  },

  /**
   * POST /api/admin/kyc/:userId/review
   * Phê duyệt hoặc Từ chối hồ sơ KYC thật
   */
  reviewKyc: async (req: RequestWithContext, res: Response) => {
    const userId = String(req.params.userId || req.params.id || '')
    const { status, detail } = req.body

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Thiếu userId cần duyệt' }
      })
    }

    if (!['APPROVED', 'REJECTED'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: 'Trạng thái duyệt không hợp lệ. Chỉ chấp nhận APPROVED hoặc REJECTED'
        }
      })
    }

    const adminId = req.userId || 'admin-system'

    try {
      const result = await KycService.reviewKyc(
        userId,
        { status, detail },
        adminId,
        req.requestId || 'req-unknown'
      )

      return res.json(result)
    } catch (err: any) {
      return res.status(502).json({
        success: false,
        error: {
          code: 'KYC_REVIEW_FAILED',
          message: err.message || 'Xử lý duyệt hồ sơ KYC thất bại'
        }
      })
    }
  },

  /**
   * GET /api/admin/merchants
   * Lấy danh sách Merchant đối tác thật
   */
  getMerchantList: async (req: RequestWithContext, res: Response) => {
    try {
      const page = parseInt(req.query.page as string || '1', 10)
      const limit = parseInt(req.query.limit as string || '10', 10)
      const search = (req.query.search as string || '').trim()
      const status = req.query.status as any

      const result = await MerchantAdminService.getMerchantList(
        { page, limit, search, status },
        req.requestId || 'req-unknown'
      )

      return res.json({
        success: true,
        data: result,
        message: 'Lấy danh sách Merchant thành công'
      })
    } catch (err: any) {
      return res.status(502).json({
        success: false,
        error: {
          code: 'MERCHANT_FETCH_FAILED',
          message: err.message || 'Không thể lấy danh sách Merchant từ merchant-service'
        }
      })
    }
  },

  /**
   * POST /api/admin/merchants/:merchantId/review
   * Phê duyệt hoặc Từ chối Merchant thật
   */
  reviewMerchant: async (req: RequestWithContext, res: Response) => {
    const merchantId = String(req.params.merchantId || req.params.id || '')
    const { status, detail } = req.body

    if (!merchantId) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Thiếu merchantId cần duyệt' }
      })
    }

    if (!['APPROVED', 'REJECTED'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: 'Trạng thái duyệt không hợp lệ. Chỉ chấp nhận APPROVED hoặc REJECTED'
        }
      })
    }

    const adminId = req.userId || 'admin-system'

    try {
      const result = await MerchantAdminService.reviewMerchant(
        merchantId,
        { status, detail },
        adminId,
        req.requestId || 'req-unknown'
      )

      return res.json(result)
    } catch (err: any) {
      return res.status(502).json({
        success: false,
        error: {
          code: 'MERCHANT_REVIEW_FAILED',
          message: err.message || 'Xử lý duyệt Merchant thất bại'
        }
      })
    }
  },

  /**
   * GET /api/admin/audit-logs
   * Lấy danh sách lịch sử thao tác kiểm toán thật từ DB
   */
  getAuditLogs: async (req: RequestWithContext, res: Response) => {
    try {
      const page = parseInt(req.query.page as string || '1', 10)
      const limit = parseInt(req.query.limit as string || '10', 10)
      const action = req.query.action as string | undefined
      const adminId = req.query.adminId as string | undefined
      const targetId = req.query.targetId as string | undefined

      const result = await AuditService.getLogs({
        page,
        limit,
        action,
        adminId,
        targetId
      })

      return res.json({
        success: true,
        data: result,
        message: 'Lấy nhật ký kiểm toán thành công'
      })
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: {
          code: 'AUDIT_LOG_FETCH_FAILED',
          message: err.message || 'Không thể truy vấn nhật ký kiểm toán'
        }
      })
    }
  }
}
