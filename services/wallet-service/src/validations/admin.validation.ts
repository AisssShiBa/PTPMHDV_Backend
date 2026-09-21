import { z } from 'zod';
import { ownerIdParamSchema, ownerTypeQuerySchema, amountSchema } from './wallet.validation';

export const adjustSchema = ownerIdParamSchema.merge(ownerTypeQuerySchema).merge(z.object({
  body: z.object({
    amount: amountSchema,
    referenceId: z.string().min(1, "referenceId không được để trống"),
    direction: z.enum(['CREDIT', 'DEBIT'], { message: "direction phải là CREDIT hoặc DEBIT" }),
    reason: z.string().optional(),
  }),
}));

export const listWalletsSchema = z.object({
  query: z.object({
    userId: z.string().uuid({ message: "userId phải là định dạng UUID hợp lệ" }).optional(),
    ownerType: z.enum(['USER', 'MERCHANT', 'SYSTEM']).optional(),
    status: z.enum(['ACTIVE', 'LOCKED']).optional(),
    page: z.string().transform(Number).optional(),
    limit: z.string().transform(Number).optional(),
  }),
});
