import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { prisma } from '../config/prisma'
export const protectedRoute = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization
    const token = authHeader?.split(' ')[1]

    if (!token) {
      return res.status(401).json({ message: 'Chưa đăng nhập' })
    }

    const decoded = jwt.verify(
      token,
      process.env.ACCESS_TOKEN_SECRET as string
    ) as { userId: number }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, createdAt: true }
    })

    if (!user) {
      return res.status(401).json({ message: 'Người dùng không tồn tại' })
    }
    // Gắn thông tin người dùng vào request để sử dụng trong các middleware hoặc route tiếp theo
    ;(req as any).user = user
    next()
  } catch (error) {
    return res
      .status(401)
      .json({ message: 'Token không hợp lệ hoặc đã hết hạn' })
  }
}
