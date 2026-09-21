import { z } from 'zod';

const amountSchema = z.string()
  .refine((val) => !isNaN(Number(val)) && isFinite(Number(val)), {
    message: "amount phải là một số hợp lệ"
  })
  .refine((val) => Number(val) > 0, {
    message: "amount phải lớn hơn 0"
  })
  .refine((val) => {
    const parts = val.split('.');
    return !parts[1] || parts[1].length <= 2;
  }, {
    message: "amount chỉ được tối đa 2 chữ số thập phân"
  });

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
    amount: amountSchema,
    referenceId: z.string(),
    expiresAt: z.string(),
  }),
}));

export const referenceSchema = ownerIdParamSchema.merge(ownerTypeQuerySchema).merge(z.object({
  body: z.object({
    referenceId: z.string(),
  }),
}));

export const transferSchema = ownerIdParamSchema.merge(z.object({
  body: z.object({
    toUserId: z.string(),
    amount: amountSchema,
    referenceId: z.string(),
  }),
}));

export const creditDebitSchema = ownerIdParamSchema.merge(ownerTypeQuerySchema).merge(z.object({
  body: z.object({
    amount: amountSchema,
    referenceId: z.string(),
    transferType: z.enum(['TOPUP', 'PAYMENT', 'REFUND', 'P2P_TRANSFER', 'ADJUSTMENT'], {
      message: "transferType không hợp lệ"
    }).optional(),
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
