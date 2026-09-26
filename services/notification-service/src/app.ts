import express from 'express'
import cors from 'cors'
import notificationRoute from './routes/notificationRoute'
import { errorHandler } from './middlewares/errorHandler'
import { requireGateway } from './middlewares/requireGateway'
import { env } from './config/env'

const app = express()
app.use(express.json())
app.use(cors({ origin: env.clientUrl, credentials: true }))

// Health Check — phục vụ kiểm tra sức khoẻ container qua Gateway
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'notification-service', port: env.port })
})
app.get('/api/notifications/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'notification-service', port: env.port })
})

// internal + client routes
app.use('/api/notifications', requireGateway, notificationRoute)

// Xử lý Route không tồn tại (404)
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'Endpoint không tồn tại'
    }
  })
})

// Middleware bắt lỗi toàn cục
app.use(errorHandler)

export default app