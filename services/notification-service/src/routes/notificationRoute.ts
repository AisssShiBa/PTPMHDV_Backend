import express from 'express'
import { internalAuth } from '../middlewares/internalAuth'
import { clientAuth } from '../middlewares/clientAuth'
import {
  createNotification,
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead
} from '../controllers/notificationController'

const route = express.Router()

// ── THỨ TỰ CỨNG (KHÔNG ĐƯỢC ĐẢO — xem README/plan) ────────────────
// 1. Nội bộ: chỉ Outbox Scheduler của Payment/Wallet gọi
route.post('/', internalAuth, createNotification)

// 2. CLIENT routes — tự-guard: user chỉ xem/đọc thông báo của CHÍNH MÌNH
//    `read-all` khai báo TRƯỚC `read` để Express khớp đuôi dài hơn trước.
route.patch('/:userId/read-all', clientAuth, markAllNotificationsRead)
route.patch('/:id/read', clientAuth, markNotificationRead)
route.get('/:userId', clientAuth, getNotifications)

export default route
