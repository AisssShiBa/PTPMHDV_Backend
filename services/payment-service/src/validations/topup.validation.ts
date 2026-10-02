import { z } from 'zod';

export const createTopupSchema = z.object({
  body: z.object({
    amount: z.number().positive().min(10000, 'Tối thiểu 10,000 VND').max(100000000, 'Tối đa 100,000,000 VND')
  }),
});

export const paramIdSchema = z.object({
  params: z.object({
    id: z.string().uuid()
  }),
});

export const rejectTopupSchema = z.object({
  params: z.object({
    id: z.string().uuid()
  }),
  body: z.object({
    reason: z.string().min(1, 'Lý do từ chối là bắt buộc').max(500)
  })
});
