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

const outletParams = z.object({ id: z.string().uuid(), outletId: z.string().uuid() })
// The QR canonical form is pipe-delimited, so a code may never contain the separator.
const outletCode = z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Code may only contain letters, digits, hyphen and underscore')
export const createOutletSchema = z.object({ params: idParams, body: z.object({
  name: z.string().trim().min(1).max(200),
  code: outletCode
}).strict() })
export const listOutletsSchema = z.object({ params: idParams, query: pageQuery })
export const getOutletQrSchema = z.object({ params: outletParams })

const apiKeyParams = z.object({ id: z.string().uuid(), keyId: z.string().uuid() })
export const createApiKeySchema = z.object({ params: idParams })
export const revokeApiKeySchema = z.object({ params: apiKeyParams })
