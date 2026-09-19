import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import adminRoute from './routes/adminRoute'
import { attachRequestId } from './middlewares/requestId'
import { requireGateway } from './middlewares/requireGateway'
import { requireAdmin } from './middlewares/requireAdmin'
import { errorHandler } from './middlewares/errorHandler'
import { env } from './config/env'

const app = express()

// 1. Phân tích cú pháp request body & cookie
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())

// 2. Gắn Correlation ID (X-Request-Id) và bóc tách thông tin Gateway
app.use(attachRequestId)

// 3. Cấu hình CORS
const allowedOrigins = [
  env.clientUrl,
  'http://localhost:5173',
  'http://localhost:5174'
].filter(Boolean) as string[]

app.use(
  cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        allowedOrigins.includes(origin) ||
        /^http:\/\/localhost:\d+$/.test(origin)
      ) {
        return callback(null, true)
      }
      return callback(new Error('Chặn bởi chính sách CORS'))
    },
    credentials: true
  })
)

// 4. Endpoints kiểm tra sức khỏe dịch vụ (Health Check)
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'admin-service', port: env.port })
})
app.get('/api/admin/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'admin-service', port: env.port })
})

// 5. Tuyến đường API Admin chính - Phải qua Gateway & Quyền ADMIN
app.use('/api/admin', requireGateway, requireAdmin, adminRoute)

// 6. Xử lý Route không tồn tại (404)
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'Endpoint admin không tồn tại'
    }
  })
})

// 7. Bắt lỗi toàn cục
app.use(errorHandler)

export default app
