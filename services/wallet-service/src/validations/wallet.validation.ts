import { z } from 'zod';

export const ownerIdParamSchema = z.object({
  params: z.object({
    userId: z.string().uuid({ message: "userId phải là định dạng UUID hợp lệ" }),
  }),
});

export const ownerTypeQuerySchema = z.object({
  query: z.object({
    ownerType: z.enum(['USER', 'MERCHANT', 'SYSTEM'], {
      message: "ownerType không hợp lệ (chỉ nhận USER, MERCHANT, SYSTEM)"
    }).optional(),
  }),
});

export const createWalletSchema = z.object({
  body: z.object({
    userId: z.string()
      .uuid({ message: "userId phải là định dạng UUID hợp lệ" }),
    ownerType: z.enum(['USER', 'MERCHANT', 'SYSTEM'], {
      message: "ownerType không hợp lệ (chỉ nhận USER, MERCHANT, SYSTEM)"
    }).optional(),
    currency: z.enum(['VND'], {
      message: "Hệ thống chỉ hỗ trợ loại tiền tệ là VND"
    }).optional(),
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
    fromUserId: z.string(),
    toUserId: z.string(),
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
