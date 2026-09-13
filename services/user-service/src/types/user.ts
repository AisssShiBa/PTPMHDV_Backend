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
  id: string
  authUserId: string
  email: string
  fullName?: string | null
  phone?: string | null
  address?: string | null
  kycStatus: string
  idNumber?: string | null
  idImageUrl?: string | null
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
