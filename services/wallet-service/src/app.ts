import cors from 'cors'
import express from 'express'
import walletRoutes from './routes/wallet.route'
import { errorHandler } from './middlewares/errorHandler'

const app = express()

app.use(express.json())
app.use(cors())
app.use('/api/wallets', walletRoutes)

app.use((_req, res) => {
  res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' })
})

app.use(errorHandler)

export default app
