import { z } from 'zod'

/**
 * Regex kiểm tra mã PIN chuẩn ngân hàng/Fintech: Đúng 6 ký tự số từ 0-9
 */
const PIN_REGEX = /^\d{6}$/

/**
 * 1. Schema cài đặt mã PIN lần đầu (Setup PIN)
 * Yêu cầu:
 * - pin: Đúng 6 chữ số
 * - confirmPin: Đúng 6 chữ số và phải trùng khớp với pin
 */
export const setupPinSchema = z
  .object({
    pin: z
      .string({ message: 'Mã PIN là bắt buộc' })
      .regex(PIN_REGEX, 'Mã PIN phải bao gồm đúng 6 chữ số (0-9)'),
    confirmPin: z
      .string({ message: 'Xác nhận mã PIN là bắt buộc' })
      .regex(PIN_REGEX, 'Xác nhận mã PIN phải bao gồm đúng 6 chữ số (0-9)')
  })
  .refine((data) => data.pin === data.confirmPin, {
    message: 'Mã xác nhận PIN không trùng khớp',
    path: ['confirmPin']
  })

export type SetupPinInput = z.infer<typeof setupPinSchema>

/**
 * 2. Schema xác thực mã PIN cho giao dịch (Verify PIN)
 * Yêu cầu:
 * - pin: Đúng 6 chữ số
 * - paymentId: Mã giao dịch cần thanh toán (bắt buộc)
 * - amount: Số tiền giao dịch (hỗ trợ cả number hoặc string số nguyên dương)
 * 
 * Lưu ý: paymentId và amount là bắt buộc để Auth Service gắn chặt vào 
 * transactionToken, chống việc đánh tráo giao dịch hoặc sửa đổi số tiền.
 */
export const verifyPinSchema = z.object({
  pin: z
    .string({ message: 'Mã PIN là bắt buộc' })
    .regex(PIN_REGEX, 'Mã PIN phải bao gồm đúng 6 chữ số (0-9)'),
  paymentId: z
    .string({ message: 'paymentId là bắt buộc' })
    .min(1, 'paymentId không được để trống'),
  amount: z
    .union([
      z.number().positive('Số tiền phải lớn hơn 0'),
      z.string().regex(/^\d+$/, 'Số tiền phải là số nguyên dương')
    ])
    .transform((val) => String(val)) // Chuẩn hóa về chuỗi để đồng nhất claim JWT
})

export type VerifyPinInput = z.infer<typeof verifyPinSchema>

/**
 * 3. Schema đổi mã PIN (Change PIN)
 * Yêu cầu:
 * - oldPin: Đúng 6 chữ số
 * - newPin: Đúng 6 chữ số và khác oldPin
 * - confirmNewPin: Phải trùng khớp với newPin
 */
export const changePinSchema = z
  .object({
    oldPin: z
      .string({ message: 'Mã PIN cũ là bắt buộc' })
      .regex(PIN_REGEX, 'Mã PIN cũ phải bao gồm đúng 6 chữ số (0-9)'),
    newPin: z
      .string({ message: 'Mã PIN mới là bắt buộc' })
      .regex(PIN_REGEX, 'Mã PIN mới phải bao gồm đúng 6 chữ số (0-9)'),
    confirmNewPin: z
      .string({ message: 'Xác nhận mã PIN mới là bắt buộc' })
      .regex(PIN_REGEX, 'Xác nhận mã PIN mới phải bao gồm đúng 6 chữ số (0-9)')
  })
  .refine((data) => data.newPin === data.confirmNewPin, {
    message: 'Xác nhận mã PIN mới không trùng khớp',
    path: ['confirmNewPin']
  })
  .refine((data) => data.oldPin !== data.newPin, {
    message: 'Mã PIN mới không được trùng với mã PIN hiện tại',
    path: ['newPin']
  })

export type ChangePinInput = z.infer<typeof changePinSchema>
