export interface PageResponse<T> {
  content: T[]
  page: number
  limit: number
  totalElements: number
  totalPages: number
  isMockData?: boolean
  warning?: string
}

export interface ApiResponse<T = any> {
  success: boolean
  data?: T
  message?: string
  warning?: string
  isMockData?: boolean
  error?: {
    code: string
    message: string
    details?: any
  }
}

export interface AdminAuditLogRecord {
  id: string
  adminId: string
  action: string
  targetId: string
  detail: string | null
  createdAt: Date | string
}

export interface DashboardStats {
  users: {
    total: number
    kycBreakdown: {
      none: number
      pending: number
      approved: number
      rejected: number
    }
  }
  merchants: {
    total: number
    statusBreakdown: {
      pending: number
      approved: number
      rejected: number
    }
  }
  audits: {
    totalLogs: number
    todayActionsCount: number
    recentActivities: AdminAuditLogRecord[]
  }
}

export interface KycReviewDto {
  status: 'APPROVED' | 'REJECTED'
  detail?: string
}

export interface MerchantReviewDto {
  status: 'APPROVED' | 'REJECTED'
  detail?: string
}

export interface ServiceCallContext {
  requestId: string
  adminId: string
}
