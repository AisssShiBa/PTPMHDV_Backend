import { env } from '../config/env'
import { DashboardStats } from '../types'
import { AuditService } from './auditService'

/**
 * Service tổng hợp Dashboard: Lấy số liệu thật 100% từ các service và database
 */
export const DashboardService = {
  /**
   * Tổng hợp dữ liệu thống kê thật toàn hệ thống cho Dashboard
   */
  getOverviewStats: async (requestId: string): Promise<DashboardStats> => {
    const userStats = {
      total: 0,
      kycBreakdown: { none: 0, pending: 0, approved: 0, rejected: 0 }
    }

    const merchantStats = {
      total: 0,
      statusBreakdown: { pending: 0, approved: 0, rejected: 0 }
    }

    // Thực thi song song cả 3 truy vấn để tối ưu thời gian phản hồi
    const [userRes, merchantRes, auditStats] = await Promise.all([
      // 1. Lấy dữ liệu người dùng từ user-service
      fetch(`${env.userServiceUrl}/api/users?limit=1000`, {
        method: 'GET',
        headers: {
          'x-request-id': requestId,
          'x-internal-key': env.internalKey,
          'x-user-role': 'ADMIN'
        },
        signal: AbortSignal.timeout(2000)
      }).catch(err => {
        console.error('[DASHBOARD ERROR] Không lấy được số liệu từ user-service:', err.message || err)
        return null
      }),

      // 2. Lấy dữ liệu đối tác từ merchant-service
      fetch(`${env.merchantServiceUrl}/api/merchants?limit=1000`, {
        method: 'GET',
        headers: {
          'x-request-id': requestId,
          'x-internal-key': env.internalKey,
          'x-user-role': 'ADMIN'
        },
        signal: AbortSignal.timeout(2000)
      }).catch(err => {
        console.error('[DASHBOARD ERROR] Không lấy được số liệu từ merchant-service:', err.message || err)
        return null
      }),

      // 3. Lấy dữ liệu nhật ký kiểm toán từ database PostgreSQL
      AuditService.getStats()
    ])

    if (userRes && userRes.ok) {
      try {
        const json = await userRes.json()
        const users: any[] = json.data?.content || []
        userStats.total = json.data?.totalElements || users.length
        users.forEach(u => {
          const status = (u.kycStatus || 'NONE').toLowerCase()
          if (status === 'none') userStats.kycBreakdown.none++
          else if (status === 'pending') userStats.kycBreakdown.pending++
          else if (status === 'approved') userStats.kycBreakdown.approved++
          else if (status === 'rejected') userStats.kycBreakdown.rejected++
        })
      } catch (err: any) {
        console.error('[DASHBOARD PARSE ERROR] Lỗi phân tích JSON user-service:', err.message)
      }
    }

    if (merchantRes && merchantRes.ok) {
      try {
        const json = await merchantRes.json()
        const merchants: any[] = json.data?.content || []
        merchantStats.total = json.data?.totalElements || merchants.length
        merchants.forEach(m => {
          const status = (m.status || 'PENDING').toLowerCase()
          if (status === 'pending') merchantStats.statusBreakdown.pending++
          else if (status === 'approved') merchantStats.statusBreakdown.approved++
          else if (status === 'rejected') merchantStats.statusBreakdown.rejected++
        })
      } catch (err: any) {
        console.error('[DASHBOARD PARSE ERROR] Lỗi phân tích JSON merchant-service:', err.message)
      }
    }

    return {
      users: userStats,
      merchants: merchantStats,
      audits: {
        totalLogs: auditStats.totalLogs,
        todayActionsCount: auditStats.todayActionsCount,
        recentActivities: auditStats.recentActivities
      }
    }
  }
}
