import { Request, Response } from 'express'
import { prisma } from '../config/prisma'
import { NotificationType } from '../types/notification'

// ===================================================================
// INTERNAL — chỉ Outbox Scheduler của Payment/Wallet gọi (POST /)
// ===================================================================
export const createNotification = async (req: Request, res: Response) => {
  try {
    const { userId, type, message } = req.body
    if (!userId || !type || !message) {
      return res.status(400).json({ message: 'userId, type và message là bắt buộc' })
    }
    if (!(type in NotificationType)) {
      return res.status(400).json({ message: `type không hợp lệ: ${type}` })
    }
    const notification = await prisma.notification.create({
      data: { userId, type, message }
    })
    return res.status(201).json({
      message: 'Tạo thông báo thành công',
      data: notification
    })
  } catch (error) {
    console.error('Lỗi tạo thông báo:', error)
    return res.status(500).json({ message: 'Lỗi hệ thống' })
  }
}

// ===================================================================
// CLIENT — Xem danh sách PHÂN TRANG + badge unreadCount (UC-12 / UC-13)
// Self-guard cứng: user chỉ xem thông báo của CHÍNH MÌNH (không ngoại lệ ADMIN)
// ===================================================================
export const getNotifications = async (req: Request, res: Response) => {
  try {
    const { userId } = req.params as { userId: string }

    // SELF-GUARD CỨNG — trước khi query
    if (req.userId !== userId) {
      return res.status(403).json({ message: 'Không có quyền xem thông báo của người khác' })
    }

    // Phân trang từ query (clamp: page ≥ 1, 1 ≤ limit ≤ 50)
    const page = Math.max(parseInt(req.query.page as string) || 1, 1)
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
      userId,
      notifications,
      unreadCount,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    })
  } catch (error) {
    console.error('Lỗi lấy thông báo:', error)
    return res.status(500).json({ message: 'Lỗi hệ thống' })
  }
}

// ===================================================================
// CLIENT — Đánh dấu MỘT thông báo đã đọc (PATCH /:id/read)
// Self-guard: chỉ được update thông báo của CHÍNH MÌNH
// ===================================================================
export const markNotificationRead = async (req: Request, res: Response) => {
  try {
    const { id } = req.params as { id: string }
    const existing = await prisma.notification.findUnique({ where: { id } })
    if (!existing) {
      return res.status(404).json({ message: 'Không tìm thấy thông báo' })
    }
    if (existing.userId !== req.userId) {
      return res.status(403).json({ message: 'Không có quyền thao tác thông báo này' })
    }
    const notification = await prisma.notification.update({
      where: { id },
      data: { read: true }
    })
    return res.status(200).json({
      message: 'Đánh dấu đã đọc thành công',
      data: notification
    })
  } catch (error) {
    if ((error as { code?: string }).code === 'P2025') {
      return res.status(404).json({ message: 'Không tìm thấy thông báo' })
    }
    console.error('Lỗi đánh dấu đã đọc:', error)
    return res.status(500).json({ message: 'Lỗi hệ thống' })
  }
}

export const markAllNotificationsRead = async (req: Request, res: Response) => {
  try {
    const { userId } = req.params as { userId: string }
    const result = await prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true }
    })
    return res.status(200).json({
      message: 'Đánh dấu tất cả đã đọc thành công',
      userId,
      updatedCount: result.count
    })
  } catch (error) {
    console.error('Lỗi đánh dấu tất cả đã đọc:', error)
    return res.status(500).json({ message: 'Lỗi hệ thống' })
  }
}
