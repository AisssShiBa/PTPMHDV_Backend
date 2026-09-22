import { z } from 'zod';

export const checkoutSchema = z.object({
  body: z.object({
    amount: z.string({
      required_error: "amount là bắt buộc",
      invalid_type_error: "amount phải là một chuỗi",
    })
    .refine((val) => !isNaN(Number(val)) && isFinite(Number(val)), {
      message: "amount phải là một số hợp lệ"
    })
    .transform(Number)
    .refine((val) => val > 0, {
      message: "amount phải lớn hơn 0"
    })
    .refine((val) => {
      const parts = val.toString().split('.');
      return !parts[1] || parts[1].length <= 2;
    }, {
      message: "amount chỉ được tối đa 2 chữ số thập phân"
    }),
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
