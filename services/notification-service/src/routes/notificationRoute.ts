import express from 'express'
import { requireGateway } from 'finvault-internal-auth'
import { internalAuth } from '../middlewares/internalAuth'
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

// 2. Mọi route client phía dưới phải có Gateway Token hợp lệ.
route.use(requireGateway)

route.patch('/:userId/read-all', markAllNotificationsRead)
route.patch('/:id/read', markNotificationRead)
route.get('/:userId', getNotifications)

export default route
