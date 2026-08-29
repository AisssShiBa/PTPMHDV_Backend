import { Request, Response } from 'express'
import { prisma } from '../config/prisma'
export const authMe = async (req: Request, res: Response) => {
  // req.user thường được gắn bởi middleware xác thực (verifyToken) trước đó
  const userId = (req as any).user?.id

  if (!userId) {
    return res.status(401).json({ message: 'Chưa xác thực' })
  }

  const User = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      email: true,
      createdAt: true,
      firstName: true,
      lastName: true,
      password: false
    }
  })
  // ẩn password
  if (!User) {
    return res.status(404).json({ message: 'Không tìm thấy người dùng' })
  }

  return res.json(User)
}
export const test = async (req: Request, res: Response) => {
  return res.sendStatus(204)
}
