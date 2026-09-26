import http from 'http'
import jwt from 'jsonwebtoken'
import { Server as SocketIOServer } from 'socket.io'
import app from './app'
import { env } from './config/env'
import { setNotificationIO } from './socket'
import { startRabbitMqConsumer } from './services/rabbitmqConsumer'

const httpServer = http.createServer(app)
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: env.clientUrl,
    credentials: true
  }
})

io.use((socket, next) => {
  const token = socket.handshake.auth?.token
  if (typeof token !== 'string' || !token) {
    return next(new Error('Missing access token'))
  }

  try {
    const decoded = jwt.verify(token, env.accessTokenSecret) as { userId?: string }
    if (!decoded.userId) {
      return next(new Error('Invalid access token'))
    }
    socket.data.userId = decoded.userId
    return next()
  } catch {
    return next(new Error('Invalid access token'))
  }
})

io.on('connection', (socket) => {
  socket.join(`user:${socket.data.userId}`)
})

setNotificationIO(io)
void startRabbitMqConsumer()

httpServer.listen(env.port, () => {
  console.log(`Notification service chạy tại port ${env.port}`)
})