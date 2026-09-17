import { z } from 'zod'

export const createUserSchema = z.object({
  body: z.object({
    authUserId: z.string().uuid({ message: 'authUserId must be a valid UUID' }),
    email: z.string().email({ message: 'email must be a valid email address' })
  })
})

export const updateUserSchema = z.object({
  body: z.object({
    fullName: z.string().min(1).optional(),
    phone: z.string().min(1).optional(),
    address: z.string().min(1).optional()
  })
})

export const submitKycSchema = z.object({
  body: z.object({
    idNumber: z.string().min(1, { message: 'idNumber is required' }),
    idImageUrl: z.string().min(1, { message: 'idImageUrl is required' })
  })
})

export const updateKycStatusSchema = z.object({
  body: z.object({
    kycStatus: z.enum(['NONE', 'PENDING', 'APPROVED', 'REJECTED'])
  })
})
