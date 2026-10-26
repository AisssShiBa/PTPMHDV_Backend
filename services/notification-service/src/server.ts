import http from 'http'
import app from './app'
import { env } from './config/env'
import { createSocketServer } from './socket'
import { startFinanceEventsConsumer } from './services/financeEventsConsumer'
import { startRabbitMqConsumer } from './services/rabbitmqConsumer'

const httpServer = http.createServer(app)
createSocketServer(httpServer)
void startRabbitMqConsumer()
const financeEventsSupervisor = startFinanceEventsConsumer()

httpServer.listen(env.port, () => {
  console.log(`Notification service chạy tại port ${env.port}`)
})

const shutdown = (signal: string) => {
  console.log(`[Notification] Received ${signal}, shutting down`)
  httpServer.close(error => {
    if (error) console.error('[Notification] HTTP server shutdown failed', error)
  })
  void financeEventsSupervisor?.stop().catch((error: unknown) => {
    console.error('[FinVault events] Consumer shutdown failed', error)
  })
}

process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))