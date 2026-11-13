import { z } from 'zod';

export const createTopupSchema = z.object({
  headers: z.object({ 'idempotency-key': z.uuid().optional() }),
  body: z.object({
    // Retain bounded legacy integers while normalizing all service input to strings.
    amount: z.union([z.string().regex(/^[1-9]\d{0,8}$/), z.number().int().min(10000).max(100000000).transform(String)])
      .refine(value => /^[1-9]\d{0,8}$/.test(value) && BigInt(value) >= 10000n && BigInt(value) <= 100000000n, 'Số tiền từ 10.000 đến 100.000.000 VND')
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
