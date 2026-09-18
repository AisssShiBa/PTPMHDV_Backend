import { z } from 'zod';
import { ownerIdParamSchema, ownerTypeQuerySchema } from './wallet.validation';

export const adjustSchema = ownerIdParamSchema.merge(ownerTypeQuerySchema).merge(z.object({
  body: z.object({
    amount: z.string(),
    referenceId: z.string(),
    direction: z.enum(['CREDIT', 'DEBIT']),
    reason: z.string().optional(),
  }),
}));

export const listWalletsSchema = z.object({
  query: z.object({
    userId: z.string().optional(),
    ownerType: z.string().optional(),
    status: z.string().optional(),
    page: z.string().transform(Number).optional(),
    limit: z.string().transform(Number).optional(),
  }),
});
