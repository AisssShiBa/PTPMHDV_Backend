import { Request, Response } from 'express'
import { prisma } from '../config/prisma'
import { NotificationType } from '../types/notification'

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

export const getNotifications = async (req: Request, res: Response) => {
  const { userId } = req.params as { userId: string }
  const notifications = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' }
  })
  const unreadCount = notifications.filter((item) => !item.read).length
  return res.status(200).json({
    userId,
    notifications,
    unreadCount
  })
}

export const markNotificationRead = async (req: Request, res: Response) => {
  try {
    const { id } = req.params as { id: string }
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
}