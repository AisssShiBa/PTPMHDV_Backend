import http from 'http'
import app from './app'
import { env } from './config/env'
import { createSocketServer } from './socket'
import { startFinanceEventsConsumer } from './services/financeEventsConsumer'
import { startRabbitMqConsumer } from './services/rabbitmqConsumer'

const httpServer = http.createServer(app)
createSocketServer(httpServer)
void startRabbitMqConsumer()
void startFinanceEventsConsumer().catch((error: unknown) => {
  console.error('[FinVault events] Consumer startup failed', error)
})

httpServer.listen(env.port, () => {
  console.log(`Notification service chạy tại port ${env.port}`)
})