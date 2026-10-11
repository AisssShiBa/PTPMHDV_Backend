import http from 'http'
import app from './app'
import { env } from './config/env'
import { createSocketServer } from './socket'
import { startRabbitMqConsumer } from './services/rabbitmqConsumer'

const httpServer = http.createServer(app)
createSocketServer(httpServer)
void startRabbitMqConsumer()

httpServer.listen(env.port, () => {
  console.log(`Notification service chạy tại port ${env.port}`)
})