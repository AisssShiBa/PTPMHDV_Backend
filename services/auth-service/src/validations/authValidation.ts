import { z } from 'zod'

export const signUpSchema = z.object({
  email: z.string().email('Email không hợp lệ'),
  password: z.string().min(6, 'Mật khẩu phải có ít nhất 6 ký tự').max(128, 'Mật khẩu tối đa 128 ký tự'),
  username: z.string().min(3, 'Tên đăng nhập phải có ít nhất 3 ký tự').max(50, 'Tên đăng nhập tối đa 50 ký tự'),
  firstName: z.string().min(1, 'Tên là bắt buộc').max(50, 'Tên tối đa 50 ký tự'),
  lastName: z.string().min(1, 'Họ là bắt buộc').max(50, 'Họ tối đa 50 ký tự')
})

export type SignUpInput = z.infer<typeof signUpSchema>

export const signInSchema = z.object({
  username: z.string().min(1, 'Tên đăng nhập là bắt buộc').max(50, 'Tên đăng nhập không được vượt quá 50 ký tự'),
  password: z.string().min(1, 'Mật khẩu là bắt buộc').max(128, 'Mật khẩu không được vượt quá 128 ký tự')
})

export type SignInInput = z.infer<typeof signInSchema>
