import express from 'express'
import cookieParser from 'cookie-parser'
import authRoute from './routes/authRoute'
import userRoute from './routes/userRoute'
import { protectedRoute } from './middlewares/authenticate'
import cors from 'cors'
const app = express()
app.use(express.json())
app.use(cookieParser())
app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }))
//public route
app.use('/api/auth', authRoute)

// protected route
app.use(protectedRoute)
app.use('/api/user', userRoute)
export default app
