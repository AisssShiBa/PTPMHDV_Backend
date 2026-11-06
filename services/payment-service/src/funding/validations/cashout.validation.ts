import { z } from 'zod';

// VND has no fractional unit and the column is DECIMAL(20,2), so at most 18
// integer digits fit. Accepting a wider value would overflow on insert.
const amountSchema = z
  .string({ message: 'amount là bắt buộc và phải là chuỗi số nguyên VND' })
  .regex(/^\d+$/, 'amount phải là số nguyên VND')
  .refine((value) => value.length <= 18 && BigInt(value) > 0n, 'amount phải lớn hơn 0');

export const createCashOutSchema = z.object({
  headers: z
    .object({
      'idempotency-key': z
        .string({ message: "Header 'Idempotency-Key' là bắt buộc" })
        .min(1, "Header 'Idempotency-Key' không được để trống")
        .max(255, "Header 'Idempotency-Key' tối đa 255 ký tự"),
    })
    .passthrough(),
  body: z.object({
    amount: amountSchema,
    // Optional on purpose: the payout destination contract is not settled yet,
    // so the endpoint must not invent a mandatory field.
    destination: z.string().max(255).optional(),
  }),
});

export const cashOutParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid UUID format'),
  }),
});

export const confirmCashOutSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid UUID format'),
  }),
  // The token normally travels in X-Transaction-Token; the body is only a
  // fallback that requireTransactionToken already cross-checks.
  body: z.object({ transactionToken: z.string().optional() }).optional(),
});

export const mockPayoutResolveSchema = z.object({
  params: z.object({ providerRef: z.string().min(1).max(255) }),
  body: z.object({ result: z.enum(['SUCCESS', 'FAILED']) }),
});

export const mockPayoutRefSchema = z.object({
  params: z.object({ providerRef: z.string().min(1).max(255) }),
});
