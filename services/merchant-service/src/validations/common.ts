import { z } from 'zod'
export const idParams = z.object({ id: z.string().uuid() })
export const idSchema = z.object({ params: idParams })
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().max(200).default('')
})
