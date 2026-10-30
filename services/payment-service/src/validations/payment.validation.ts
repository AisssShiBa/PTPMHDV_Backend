import { z } from 'zod';

export const checkoutSchema = z.object({
  body: z.object({
    amount: z.string().regex(/^[1-9]\d{0,15}$/, 'amount must be a positive integer VND string'),
    destinationUserId: z.string().uuid(),
    type: z.enum(['WALLET_TRANSFER']),
    referenceId: z.string().max(255).optional(),
    callbackTopic: z.string().max(100).optional(),
    idempotencyKey: z.string().min(1).max(255).optional()
  })
});
export const confirmSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ transactionToken: z.string().min(1).max(4096) }).strict()
});

export const paramIdSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid UUID format'),
  }),
});

export const paginationSchema = z.object({
  query: z.object({
    userId: z.string().optional(),
    type: z.string().optional(),
    status: z.string().optional(),
  }),
});
