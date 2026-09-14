import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import userRoute from './routes/userRoute'
import { attachRequestId } from './middlewares/requestId'
import { requireGateway } from './middlewares/requireGateway'

const app = express()

app.use(express.json())
app.use(cookieParser())
app.use(attachRequestId)

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

// Health Check Endpoints
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'user-service' }))
app.get('/api/users/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'user-service' }))

// Protected routes (must pass through Gateway or internal call)
app.use('/api/users', requireGateway, userRoute)

export default app
