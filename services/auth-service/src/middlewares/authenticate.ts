import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { fail } from '../utils/response'

// Interface định nghĩa Payload của Access Token
interface JwtPayload {
  userId: string
  role: string
}

export const protectedRoute = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization
    const token = authHeader?.split(' ')[1] // Lấy chuỗi token sau chữ 'Bearer'

    if (!token) {
      return fail(res, 401, 'UNAUTHORIZED', 'Chưa đăng nhập hoặc thiếu Token')
    }

    // 1. Chỉ giải mã và kiểm tra chữ ký Token (Mất ~0ms, không tốn I/O truy vấn DB)
    const decoded = jwt.verify(
      token,
      process.env.ACCESS_TOKEN_SECRET as string
    ) as JwtPayload

    // 2. Gắn thẳng payload đã giải mã vào req.user để các Controller phía sau dùng
    ;(req as any).user = {
      id: decoded.userId,
      role: decoded.role
    }

    // 3. Cho phép request đi tiếp
    next()
  } catch (error) {
    // Catch toàn bộ lỗi do jwt.verify quăng ra (Token hết hạn, sai secret, sai định dạng)
    return fail(res, 401, 'INVALID_TOKEN', 'Token không hợp lệ hoặc đã hết hạn')
  }
}
