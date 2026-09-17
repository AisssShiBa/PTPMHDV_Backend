import { z } from 'zod'

export const registerMerchantSchema = z.object({
  body: z.object({
    businessName: z.string().min(1, { message: 'businessName is required' }),
    taxId: z.string().optional().nullable(),
    bankAccount: z.string().optional().nullable()
  })
})

export const updateMerchantSchema = z.object({
  body: z.object({
    businessName: z.string().min(1).optional(),
    taxId: z.string().optional().nullable(),
    bankAccount: z.string().optional().nullable()
  })
})

export const updateMerchantStatusSchema = z.object({
  body: z.object({
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED'])
  })
})
