import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import authRoute from './routes/authRoute'
import { attachRequestId } from './middlewares/requestId'

const app = express()

app.use(express.json())
app.use(cookieParser())

// 1. Đặt Middleware Correlation ID ngay đầu tiên để theo vết mọi request
app.use(attachRequestId)

// 2. Cấu hình CORS
const allowedOrigins = [
  process.env.CLIENT_URL,
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

// 3. Mount Routes
app.use('/api/auth', authRoute)

export default app
