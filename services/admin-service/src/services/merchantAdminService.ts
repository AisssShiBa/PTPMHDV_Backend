import { env } from '../config/env'
import { MerchantReviewDto, PageResponse } from '../types'
import { AuditService } from './auditService'

export type MerchantRecord = {
  id: string
  ownerId: string
  businessName: string
  taxId: string | null
  bankAccount: string | null
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  createdAt: string
  updatedAt: string
}

export type MerchantListParams = {
  page?: number
  limit?: number
  search?: string
  status?: 'PENDING' | 'APPROVED' | 'REJECTED'
}

/**
 * Service quản lý đối tác: Kết nối trực tiếp merchant-service (100% dữ liệu thật, KHÔNG DÙNG MOCK)
 */
export const MerchantAdminService = {
  /**
   * 1. Lấy danh sách đối tác thật từ merchant-service
   */
  getMerchantList: async (params: MerchantListParams, requestId: string): Promise<PageResponse<MerchantRecord>> => {
    const page = params.page || 1
    const limit = params.limit || 10
    const search = params.search || ''

    const url = new URL(`${env.merchantServiceUrl}/api/merchants`)
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
      throw new Error(`Lỗi từ merchant-service (${res.status}): ${errorText}`)
    }

    const json = await res.json()
    return json.data
  },

  /**
   * 2. Phê duyệt hoặc từ chối Merchant thật trên merchant-service và ghi log
   */
  reviewMerchant: async (merchantId: string, dto: MerchantReviewDto, adminId: string, requestId: string): Promise<any> => {
    const { status, detail } = dto
    const targetUrl = `${env.merchantServiceUrl}/api/merchants/${merchantId}/status`

    // Bước 1: Gửi request thật sang merchant-service để đổi trạng thái
    const res = await fetch(targetUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': requestId,
        'x-internal-key': env.internalKey,
        'x-user-role': 'ADMIN'
      },
      body: JSON.stringify({ status }),
      signal: AbortSignal.timeout(2000)
    })

    if (!res.ok) {
      const errorBody = await res.text()
      throw new Error(`Đổi trạng thái Merchant thất bại. merchant-service trả lỗi (${res.status}): ${errorBody}`)
    }

    const json = await res.json()
    const updateResult = json.data

    // Bước 2: Ghi vào bảng AdminAuditLog thật trong PostgreSQL
    const actionName = status === 'APPROVED' ? 'APPROVE_MERCHANT' : 'REJECT_MERCHANT'
    const auditResult = await AuditService.logAction({
      adminId,
      action: actionName,
      targetId: merchantId,
      detail: detail || (status === 'APPROVED' ? 'Duyệt merchant hợp lệ' : 'Từ chối merchant')
    })

    if (!auditResult.success) {
      console.error(`[AUDIT ALERT] Đã đổi Merchant thành công nhưng không ghi được AuditLog:`, auditResult.error)
      return {
        success: true,
        data: updateResult,
        warning: 'AUDIT_LOG_FAILED',
        message: `Đã cập nhật trạng thái Merchant thành ${status}, nhưng chưa lưu được log kiểm toán vào DB.`
      }
    }

    return {
      success: true,
      data: updateResult,
      auditLog: auditResult.data,
      message: `Cập nhật trạng thái Merchant thành ${status} và lưu nhật ký thành công`
    }
  }
}
