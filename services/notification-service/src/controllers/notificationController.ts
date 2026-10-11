import { Request, Response } from 'express'
import { prisma } from '../config/prisma'
import { notificationIO } from '../socket'
import { createNotificationRecord, isNotificationType } from '../services/notificationService'

export const getSocketTicket = async (req: Request, res: Response) => {
  const ticket = req.headers['x-gateway-token']
  if (typeof ticket !== 'string' || ticket.length === 0) {
    return res.status(401).json({
      success: false,
      error: { code: 'INVALID_GATEWAY_TOKEN', message: 'Gateway Token không hợp lệ hoặc đã hết hạn.' }
    })
  }

  // Ticket chỉ chứng minh danh tính đã xác thực của user hiện tại trong tối đa 60 giây; không ghi ticket vào log.
  return res.status(200).json({
    success: true,
    data: { ticket }
  })
}

// ===================================================================
// INTERNAL — chỉ Outbox Scheduler của Payment/Wallet gọi (POST /)
// ===================================================================
export const createNotification = async (req: Request, res: Response) => {
  try {
    const { userId, type, message } = req.body
    if (!userId || !type || !message) {
      return res.status(400).json({
        success: false,
        error: { code: 'BAD_REQUEST', message: 'userId, type và message là bắt buộc' }
      })
    }
    if (!isNotificationType(type)) {
      return res.status(400).json({
        success: false,
        error: { code: 'BAD_REQUEST', message: `type không hợp lệ: ${type}` }
      })
    }
    const notification = await createNotificationRecord(userId, type, message)
    notificationIO?.to(`user:${userId}`).emit('notification:new', notification)
    return res.status(201).json({
      message: 'Tạo thông báo thành công',
      data: notification
    })
  } catch (error) {
    console.error('Lỗi tạo thông báo:', error)
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Lỗi hệ thống' }
    })
  }
}

// ===================================================================
// CLIENT — Xem danh sách PHÂN TRANG + badge unreadCount (UC-12 / UC-13)
// Self-guard cứng: user chỉ xem thông báo của CHÍNH MÌNH (không ngoại lệ ADMIN)
// ===================================================================
export const getNotifications = async (req: Request, res: Response) => {
  try {
    const userId = req.auth!.userId

    // Phân trang từ query (clamp: page ≥ 1, 1 ≤ limit ≤ 50)
    const requestedPage = Number.parseInt(req.query.page as string, 10)
    const page = Number.isFinite(requestedPage) ? Math.max(requestedPage, 1) : 1
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 50)
    const skip = (page - 1) * limit

    // Badge unreadCount đếm TỪ DB — KHÔNG đếm JS trên danh sách phân trang
    const [notifications, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.notification.count({ where: { userId } }),
      prisma.notification.count({ where: { userId, read: false } })
    ])

    return res.status(200).json({
      success: true,
      data: {
        notifications,
        unreadCount,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    })
  } catch (error) {
    console.error('Lỗi lấy thông báo:', error)
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Lỗi hệ thống' },
      requestId: req.get('x-request-id')
    })
  }
}

// ===================================================================
// CLIENT — Đánh dấu MỘT thông báo đã đọc (PATCH /:id/read)
// Self-guard: chỉ được update thông báo của CHÍNH MÌNH
// ===================================================================
export const markNotificationRead = async (req: Request, res: Response) => {
  try {
    const { id } = req.params as { id: string }
    const userId = req.auth!.userId
    const result = await prisma.notification.updateMany({
      where: { id, userId },
      data: { read: true }
    })
    if (result.count === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Không tìm thấy thông báo' },
        requestId: req.get('x-request-id')
      })
    }
    const notification = await prisma.notification.findFirst({
      where: { id, userId }
    })
    if (!notification) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Không tìm thấy thông báo' },
        requestId: req.get('x-request-id')
      })
    }
    return res.status(200).json({
      success: true,
      data: notification
    })
  } catch (error) {
    console.error('Lỗi đánh dấu đã đọc:', error)
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Lỗi hệ thống' },
      requestId: req.get('x-request-id')
    })
  }
}

export const markAllNotificationsRead = async (req: Request, res: Response) => {
  try {
    const userId = req.auth!.userId
    const result = await prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true }
    })
    return res.status(200).json({
      success: true,
      data: { updatedCount: result.count }
    })
  } catch (error) {
    console.error('Lỗi đánh dấu tất cả đã đọc:', error)
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Lỗi hệ thống' },
      requestId: req.get('x-request-id')
    })
  }
}
