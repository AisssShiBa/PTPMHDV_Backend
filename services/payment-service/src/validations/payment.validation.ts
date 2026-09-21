import { z } from 'zod';

export const checkoutSchema = z.object({
  body: z.object({
    amount: z.number(),
    type: z.enum(['CARD_TOPUP', 'BUS_TICKET', 'MOVIE_TICKET', 'TRAIN_TICKET', 'WALLET_TRANSFER']),
    referenceId: z.string().optional(),
    callbackTopic: z.string(),
    idempotencyKey: z.string(),
  }),
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
