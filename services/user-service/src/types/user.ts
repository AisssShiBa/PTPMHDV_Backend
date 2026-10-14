export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
  } | null
  message?: string | null
}

export interface UserResponse {
  /** Local profile ID. The API field name remains id for compatibility. */
  id: string
  /** Account ID issued by auth-service; matches req.auth.userId. */
  authUserId: string
  email: string
  fullName?: string | null
  phone?: string | null
  address?: string | null
  kycStatus: string
  idNumber?: string | null
  kycTier: number
  hasKycDocument: boolean
  createdAt: Date | string
  updatedAt: Date | string
}

export interface PageResponse<T> {
  content: T[]
  page: number
  limit: number
  totalElements: number
  totalPages: number
}
