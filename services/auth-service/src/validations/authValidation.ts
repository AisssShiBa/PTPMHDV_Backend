import { z } from 'zod'

export const signUpSchema = z.object({
  email: z.string().email('Email không hợp lệ'),
  password: z.string().min(6, 'Mật khẩu phải có ít nhất 6 ký tự'),
  username: z.string().min(3, 'Tên đăng nhập phải có ít nhất 3 ký tự'),
  firstName: z.string().min(1, 'Tên là bắt buộc'),
  lastName: z.string().min(1, 'Họ là bắt buộc')
})

// Type này dùng để gõ kiểu cho biến `data` sau khi validate xong — khỏi viết interface riêng
export type SignUpInput = z.infer<typeof signUpSchema>
