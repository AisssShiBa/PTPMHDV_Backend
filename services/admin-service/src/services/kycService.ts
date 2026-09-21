import { env } from '../config/env'
import { KycReviewDto, PageResponse } from '../types'
import { AuditService } from './auditService'

export type UserKycRecord = {
  id: string
  authUserId: string
  email: string
  fullName: string | null
  phone: string | null
  address: string | null
  kycStatus: 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED'
  idNumber: string | null
  idImageUrl: string | null
  createdAt: string
  updatedAt: string
}

export type KycListParams = {
  page?: number
  limit?: number
  search?: string
  status?: 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED'
}

/**
 * Service quản lý KYC: Kết nối trực tiếp user-service (100% dữ liệu thật, KHÔNG DÙNG MOCK)
 */
export const KycService = {
  /**
   * 1. Lấy danh sách hồ sơ KYC thật từ user-service
   */
  getKycList: async (params: KycListParams, requestId: string): Promise<PageResponse<UserKycRecord>> => {
    const page = params.page || 1
    const limit = params.limit || 10
    const search = params.search || ''

    const url = new URL(`${env.userServiceUrl}/api/users`)
    url.searchParams.set('page', String(page))
    url.searchParams.set('limit', String(limit))
    if (search) url.searchParams.set('search', search)
    if (params.status) url.searchParams.set('status', params.status)

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'x-request-id': requestId,
        'x-internal-key': env.internalKey,
        'x-user-role': 'ADMIN'
      },
      signal: AbortSignal.timeout(2000)
    })

    if (!res.ok) {
      const errorText = await res.text()
      throw new Error(`Lỗi từ user-service (${res.status}): ${errorText}`)
    }

    const json = await res.json()
    return json.data
  },

  /**
   * 2. Phê duyệt hoặc từ chối hồ sơ KYC thật trên user-service và ghi log
   */
  reviewKyc: async (userId: string, dto: KycReviewDto, adminId: string, requestId: string): Promise<any> => {
    const { status, detail } = dto
    const targetUrl = `${env.userServiceUrl}/api/users/${userId}/kyc-status`

    // Bước 1: Gửi request thật sang user-service để đổi trạng thái
    const res = await fetch(targetUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': requestId,
        'x-internal-key': env.internalKey,
        'x-user-role': 'ADMIN'
      },
      body: JSON.stringify({ kycStatus: status }),
      signal: AbortSignal.timeout(2000)
    })

    if (!res.ok) {
      const errorBody = await res.text()
      throw new Error(`Đổi trạng thái KYC thất bại. user-service trả lỗi (${res.status}): ${errorBody}`)
    }

    const json = await res.json()
    const updateResult = json.data

    // Bước 2: Ghi vào bảng AdminAuditLog thật trong PostgreSQL
    const actionName = status === 'APPROVED' ? 'APPROVE_KYC' : 'REJECT_KYC'
    const auditResult = await AuditService.logAction({
      adminId,
      action: actionName,
      targetId: userId,
      detail: detail || (status === 'APPROVED' ? 'Duyệt hồ sơ hợp lệ' : 'Từ chối hồ sơ')
    })

    if (!auditResult.success) {
      console.error(`[AUDIT ALERT] Đã đổi KYC thành công nhưng không ghi được AuditLog:`, auditResult.error)
      return {
        success: true,
        data: updateResult,
        warning: 'AUDIT_LOG_FAILED',
        message: `Đã cập nhật trạng thái KYC thành ${status}, nhưng chưa lưu được log kiểm toán vào DB.`
      }
    }

    return {
      success: true,
      data: updateResult,
      auditLog: auditResult.data,
      message: `Cập nhật trạng thái KYC thành ${status} và lưu nhật ký thành công`
    }
  }
}
