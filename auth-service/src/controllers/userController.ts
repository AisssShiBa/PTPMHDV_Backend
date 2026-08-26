import { Request, Response } from 'express'
export const authMe = async (req: Request, res: Response) => {
  return res.json({ message: 'Người dùng đã xác thực thành công' })
}
