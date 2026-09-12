import express from 'express'
import {
  createNotification,
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead
} from '../controllers/notificationController'
const route = express.Router()

route.post('/', createNotification)
route.get('/:userId', getNotifications)
route.patch('/:id/read', markNotificationRead)
route.patch('/:userId/read-all', markAllNotificationsRead)

export default route