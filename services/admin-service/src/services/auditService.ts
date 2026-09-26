import { prisma } from '../config/prisma'
import { AdminAuditLogRecord, PageResponse } from '../types'

export type LogActionParams = {
  adminId: string
  action: string
  targetId: string
  detail?: string | null
}

export type GetAuditLogsParams = {
  page?: number
  limit?: number
  action?: string
  adminId?: string
  targetId?: string
}

export type AuditStatsResult = {
  totalLogs: number
  todayActionsCount: number
  recentActivities: AdminAuditLogRecord[]
}

export type LogActionResult = {
  success: boolean
  data?: AdminAuditLogRecord
  error?: any
}

/**
 * Service kiểm toán: Thống nhất 100% cách khai báo (ĐẦU VÀO -> ĐẦU RA Promise)
 */
export const AuditService = {
  /**
   * 1. Ghi nhận một hành động của Quản trị viên vào bảng AdminAuditLog
   * Đầu vào: (params: LogActionParams)
   * Đầu ra:  Promise<LogActionResult>
   */
  logAction: async (params: LogActionParams): Promise<LogActionResult> => {
    const { adminId, action, targetId, detail } = params

    try {
      const record = await prisma.adminAuditLog.create({
        data: {
          adminId,
          action,
          targetId,
          detail: detail || null
        }
      })

      console.log(`[AUDIT LOG] [${action}] Admin: ${adminId} -> Target: ${targetId}`)
      return { success: true, data: record }
    } catch (err: any) {
      console.error(`[AUDIT ERROR] Không thể ghi log vào database:`, err.message || err)
      return { success: false, error: err }
    }
  },

  /**
   * 2. Truy vấn danh sách lịch sử kiểm toán từ database (có phân trang và lọc)
   * Đầu vào: (params: GetAuditLogsParams)
   * Đầu ra:  Promise<PageResponse<AdminAuditLogRecord>>
   */
  getLogs: async (params: GetAuditLogsParams): Promise<PageResponse<AdminAuditLogRecord>> => {
    const page = Math.max(1, params.page || 1)
    const limit = Math.max(1, Math.min(100, params.limit || 10))
    const skip = (page - 1) * limit

    const whereClause: any = {}
    if (params.action) whereClause.action = params.action
    if (params.adminId) whereClause.adminId = params.adminId
    if (params.targetId) whereClause.targetId = params.targetId

    const [logs, totalElements] = await Promise.all([
      prisma.adminAuditLog.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' }
      }),
      prisma.adminAuditLog.count({ where: whereClause })
    ])

    const totalPages = Math.ceil(totalElements / limit) || 1

    return {
      content: logs,
      page,
      limit,
      totalElements,
      totalPages
    }
  },

  /**
   * 3. Thống kê tổng số log và hoạt động trong ngày từ database
   * Đầu vào: () không cần tham số
   * Đầu ra:  Promise<AuditStatsResult>
   */
  getStats: async (): Promise<AuditStatsResult> => {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    const [totalLogs, todayActionsCount, recentActivities] = await Promise.all([
      prisma.adminAuditLog.count(),
      prisma.adminAuditLog.count({
        where: {
          createdAt: { gte: todayStart }
        }
      }),
      prisma.adminAuditLog.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' }
      })
    ])

    return {
      totalLogs,
      todayActionsCount,
      recentActivities
    }
  }
}
