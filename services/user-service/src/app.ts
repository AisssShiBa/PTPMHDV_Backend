import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import userRoute from './routes/userRoute'
import { attachRequestId } from './middlewares/requestId'

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

app.use('/api/users', userRoute)

export default app
