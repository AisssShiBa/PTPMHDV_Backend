import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import authRoute from './routes/authRoute'
import { attachRequestId } from './middlewares/requestId'
import { requireGateway } from './middlewares/requireGateway'
import { errorHandler } from './middlewares/errorHandler'
import { env } from './config/env'

const app = express()

app.use(express.json())
app.use(cookieParser())

// 1. Gắn Correlation ID ngay đầu pipeline để theo vết log
app.use(attachRequestId)

// 2. Cấu hình CORS
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
      return callback(new Error('Blocked by CORS policy'))
    },
    credentials: true
  })
)

// 3. Endpoint kiểm tra sức khỏe hệ thống (Health Check)
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'auth-service' })
})
app.get('/api/auth/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'auth-service' })
})

// 4. Bảo vệ microservice khỏi truy cập trực tiếp bypass Gateway
app.use('/api/auth', requireGateway)

// 5. Mount Routes
app.use('/api/auth', authRoute)

// 6. Xử lý Route không tồn tại (404)
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'Endpoint không tồn tại'
    }
  })
})

// 7. Middleware bắt lỗi toàn cục
app.use(errorHandler)

export default app
