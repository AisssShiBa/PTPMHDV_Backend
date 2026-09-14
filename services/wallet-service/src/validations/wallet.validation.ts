import { z } from 'zod';

export const ownerIdParamSchema = z.object({
  params: z.object({
    userId: z.string().transform(Number),
  }),
});

export const ownerTypeQuerySchema = z.object({
  query: z.object({
    ownerType: z.string().optional(),
  }),
});

export const createWalletSchema = z.object({
  body: z.object({
    userId: z.number(),
    ownerType: z.string().optional(),
    currency: z.string().optional(),
  }),
});

export const holdSchema = ownerIdParamSchema.merge(ownerTypeQuerySchema).merge(z.object({
  body: z.object({
    amount: z.string(),
    referenceId: z.string(),
    expiresAt: z.string(),
  }),
}));

export const referenceSchema = ownerIdParamSchema.merge(ownerTypeQuerySchema).merge(z.object({
  body: z.object({
    referenceId: z.string(),
  }),
}));

export const transferSchema = z.object({
  body: z.object({
    fromUserId: z.number(),
    toUserId: z.number(),
    amount: z.string(),
    referenceId: z.string(),
  }),
});

export const creditDebitSchema = ownerIdParamSchema.merge(ownerTypeQuerySchema).merge(z.object({
  body: z.object({
    amount: z.string(),
    referenceId: z.string(),
    transferType: z.string().optional(),
  }),
}));

export const historyQuerySchema = ownerIdParamSchema.merge(z.object({
  query: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    page: z.string().transform(Number).optional(),
    limit: z.string().transform(Number).optional(),
    ownerType: z.string().optional(),
  }),
}));
