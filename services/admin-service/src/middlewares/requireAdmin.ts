import { Response, NextFunction } from 'express'
import { RequestWithContext } from './requestId'

export const requireAdmin = (req: RequestWithContext, res: Response, next: NextFunction) => {
  // Chỉ cho phép nếu người dùng có vai trò ADMIN hoặc là lệnh gọi nội bộ từ các microservice tin cậy
  if (req.userRole === 'ADMIN' || req.isInternalCall) {
    return next()
  }

  return res.status(403).json({
    success: false,
    error: {
      code: 'FORBIDDEN',
      message: 'Từ chối quyền truy cập: Chỉ Quản trị viên (ADMIN) mới có quyền thực hiện thao tác này'
    }
  })
}
