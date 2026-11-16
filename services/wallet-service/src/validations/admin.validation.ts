import { z } from 'zod';
import { ownerIdParamSchema, ownerTypeQuerySchema, amountSchema } from './wallet.validation';

export const adjustSchema = ownerIdParamSchema.merge(ownerTypeQuerySchema).merge(z.object({
  body: z.object({
    amount: amountSchema,
    referenceId: z.string().min(1, "referenceId không được để trống"),
    direction: z.enum(['CREDIT', 'DEBIT'], { message: "direction phải là CREDIT hoặc DEBIT" }),
    reason: z.string().optional(),
  }),
}));

export const listWalletsSchema = z.object({
  query: z.object({
    userId: z.string().uuid({ message: "userId phải là định dạng UUID hợp lệ" }).optional(),
    ownerType: z.enum(['USER', 'MERCHANT', 'SYSTEM']).optional(),
    status: z.enum(['ACTIVE', 'LOCKED']).optional(),
    page: z.string().transform(Number).optional(),
    limit: z.string().transform(Number).optional(),
  }),
});

export const adjustAnomalySchema = z.object({
  params: z.object({
    id: z.string().regex(/^[1-9]\d*$/, "Anomaly id must be a positive integer"),
  }),
  body: z.object({
    reason: z.string({ message: "reason is required and must contain 5 to 500 characters" })
      .trim()
      .min(5, "reason is required and must contain 5 to 500 characters")
      .max(500, "reason must contain 5 to 500 characters"),
    direction: z.enum(['CREDIT', 'DEBIT'], {
      message: "direction must be 'CREDIT' or 'DEBIT'",
    }).optional(),
    amount: z.string()
      .regex(/^[1-9]\d*(\.\d{1,2})?$/, "amount must be a positive integer or decimal string")
      .refine(val => BigInt(val.split('.')[0]) <= 999_999_999_999_999_999n, "amount is out of range")
      .optional(),
    referenceId: z.string()
      .trim()
      .min(1, "referenceId must be a non-empty string")
      .max(255, "referenceId must not exceed 255 characters")
      .optional(),
  }),
});
