import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import authRoute from './routes/authRoute'
import pinRoute from './routes/pinRoute'
import { attachRequestId } from './middlewares/requestId'
import { errorHandler } from './middlewares/errorHandler'
import { env } from './config/env'

const app = express()

app.use(express.json())
app.use(cookieParser())

// 1. Gắn Correlation ID ngay đầu pipeline để theo vết log
app.use(attachRequestId)

// 2. Loại bỏ hoàn toàn việc chấp nhận header x-gateway-verified (chống giả mạo bypass Gateway)
app.use((req, res, next) => {
  if (req.headers['x-gateway-verified'] !== undefined) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_GATEWAY_TOKEN',
        message: 'Legacy x-gateway-verified header is rejected'
      },
      requestId: (req as any).requestId || res.getHeader('X-Request-Id')
    })
  }
  next()
})

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
      return callback(new Error('Blocked by CORS policy'))
    },
    credentials: true
  })
)

// 4. Endpoint kiểm tra sức khỏe hệ thống (Health Check)
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'auth-service' })
})
app.get('/api/auth/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'auth-service' })
})

// 4. Tuyến đường xác thực tài khoản thông thường (Public Auth)
app.use('/api/auth', authRoute)

// 5. Tuyến đường xác thực giao dịch cấp 2 (Auth-Txn: Mã PIN & transactionToken)
app.use('/api/auth-txn/pin', pinRoute)
app.use('/api/auth/pin', pinRoute) // Hỗ trợ alias

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
