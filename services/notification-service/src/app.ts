import express from 'express'
import cors from 'cors'
import notificationRoute from './routes/notificationRoute'

const app = express()
app.use(express.json())
app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }))
// internal + client routes
app.use('/api/notifications', notificationRoute)
export default app