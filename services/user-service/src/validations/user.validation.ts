import { z } from 'zod'
import { idParams, pageQuery } from './common'
const profileFields = z.object({
  fullName: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().min(1).max(30).optional(),
  address: z.string().trim().min(1).max(500).optional()
}).strict().refine(value => Object.keys(value).length > 0, 'At least one field is required')
export const createUserSchema = z.object({ body: z.object({
  authUserId: z.string().uuid(), email: z.string().trim().email().max(254)
}).strict() })
export const updateUserSchema = z.object({ params: idParams, body: profileFields })
export const updateByAuthSchema = z.object({ params: z.object({ authUserId: z.string().uuid() }), body: profileFields })
export const byAuthSchema = z.object({ params: z.object({ authUserId: z.string().uuid() }) })
const kycStatusFilter = z.preprocess(
  value => typeof value === 'string' ? value.trim().toUpperCase() || undefined : value,
  z.enum(['NONE', 'PENDING', 'APPROVED', 'REJECTED']).optional()
)
const listUsersQuery = pageQuery.extend({ status: kycStatusFilter, kycStatus: kycStatusFilter })
  .transform(({ status, kycStatus, ...query }) => ({ ...query, kycStatus: status ?? kycStatus }))
export type ListUsersQuery = z.infer<typeof listUsersQuery>
export const listUsersSchema = z.object({ query: listUsersQuery })
export const kycBody = z.object({ idNumber: z.string().trim().min(1).max(50) }).strict()
export const updateKycStatusSchema = z.object({ params: idParams, body: z.object({
  kycStatus: z.enum(['NONE', 'PENDING', 'APPROVED', 'REJECTED'])
}).strict() })
