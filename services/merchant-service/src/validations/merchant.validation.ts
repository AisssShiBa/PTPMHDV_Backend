import { z } from 'zod'
import { idParams, pageQuery } from './common'
const status = z.enum(['PENDING', 'APPROVED', 'REJECTED'])
const fields = {
  businessName: z.string().trim().min(1).max(200),
  taxId: z.string().trim().min(1).max(50).nullable().optional(),
  bankAccount: z.string().trim().min(1).max(100).nullable().optional()
}
export const registerMerchantSchema = z.object({ body: z.object({ ...fields, ownerId: z.string().uuid().optional() }).strict() })
export const updateMerchantSchema = z.object({ params: idParams, body: z.object({
  ...fields, businessName: fields.businessName.optional()
}).strict().refine(value => Object.keys(value).length > 0, 'At least one field is required') })
export const updateMerchantStatusSchema = z.object({ params: idParams, body: z.object({ status }).strict() })
export const listMerchantsSchema = z.object({ query: pageQuery.extend({ status: status.optional() }) })
