export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
  } | null
  message?: string | null
}

export interface MerchantResponse {
  id: string
  ownerId: string
  businessName: string
  taxId?: string | null
  bankAccount?: string | null
  status: string
  createdAt: Date | string
  updatedAt: Date | string
}

export interface MerchantActiveResponse {
  id: string
  ownerId?: string
  businessName?: string
  status?: string
  active: boolean
}

export interface PageResponse<T> {
  content: T[]
  page: number
  limit: number
  totalElements: number
  totalPages: number
}
