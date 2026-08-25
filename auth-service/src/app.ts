import express from 'express'
import cookieParser from 'cookie-parser'
import authRoute from './routes/authRoute'
const app = express()
app.use(express.json())
app.use(cookieParser())
app.use('/api/auth', authRoute)
export default app
