import app from './app'
import { env } from './config/env'
import { prisma } from './config/prisma'
import { initRabbitMQ } from './lib/rabbitmq'
import { OutboxWorker } from './workers/outboxWorker'

const startServer = async (): Promise<void> => {
  try {
    await prisma.$connect()
    console.log('[AUTH] Kết nối PostgreSQL thành công')
  } catch (error) {
    console.warn('[AUTH WARNING] Không thể kết nối tới PostgreSQL (vui lòng kiểm tra Docker DB):', (error as any)?.message || error)
  }

  // Khởi tạo kết nối RabbitMQ và tiến trình quét Outbox Worker
  initRabbitMQ()
  OutboxWorker.start()

  const server = app.listen(env.port, () => {
    console.log(`[AUTH] Auth Service đang lắng nghe tại cổng ${env.port}`)
  })

  // Đóng kết nối an toàn khi nhận tín hiệu dừng (Graceful Shutdown)
  const shutdown = (signal: string): void => {
    console.log(`[AUTH] Nhận tín hiệu ${signal}, đang tiến hành đóng dịch vụ...`)

    // Dừng Outbox Worker để không quét tiếp trong khi đang tắt server
    OutboxWorker.stop()

    server.close(async () => {
      await prisma.$disconnect().catch(() => {})
      console.log('[AUTH] Đã đóng HTTP server và ngắt kết nối Database an toàn.')
      process.exit(0)
    })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

void startServer()

