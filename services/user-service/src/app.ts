import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import userRoute from './routes/userRoute'
import { attachRequestId } from './middlewares/requestId'
import { requireGateway } from './middlewares/requireGateway'
import { notFound } from './middlewares/notFound'
import { errorHandler } from './middlewares/errorHandler'
import { HttpError } from './utils/errors'


const app = express()

app.use(attachRequestId)
app.use(express.json({ limit: '100kb' }))
app.use(cookieParser())

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
      return callback(new HttpError(403, 'FORBIDDEN', 'Origin is not allowed'))
    },
    credentials: true
  })
)

// Health Check Endpoints
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'user-service' }))
app.get('/api/users/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'user-service' }))

// Protected routes (must pass through Gateway or internal call)


app.use('/api/users', requireGateway, userRoute)

// 404 & Error Handler
app.use(notFound)
app.use(errorHandler)

export default app
